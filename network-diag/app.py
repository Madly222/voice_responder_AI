"""
network-diag v2 (ExampleNet)

Changes from v1:
  - ONE SSH session for the whole diagnosis (port + MAC) instead of two;
  - reads until the CLI prompt instead of fixed pauses (was ~6 s per session
    plus 5 s waiting for silence) -> diagnosis takes ~4-8 s instead of ~25 s;
  - Cisco: looks up the specific MAC (`show mac address-table address ...`)
    with fallback to the full table and to the old `show mac-address-table` syntax;
  - management network whitelist: SSH only to switch addresses, never to a client IP
    or an arbitrary host (so the NETWORK_USER password cannot leak via a spoofed address);
  - enters enable mode if the prompt is '>' and NETWORK_ENABLE is set;
  - compares the port where the MAC was found with the port from NetBox (port_match).

The /diagnose, /check-mac, /check-port, /test-ssh contract is unchanged; fields were added.
"""
import ipaddress
import os
import re
import socket
import time

import paramiko
from flask import Flask, jsonify, request

from mac_parser import mac_parser, normalize_port

app = Flask(__name__)

NETWORK_USER = os.getenv('NETWORK_USER', '')
NETWORK_PASS = os.getenv('NETWORK_PASS', '')
NETWORK_ENABLE = os.getenv('NETWORK_ENABLE', '')
CONNECT_TIMEOUT = float(os.getenv('SSH_CONNECT_TIMEOUT') or '8')
CMD_TIMEOUT = float(os.getenv('SSH_CMD_TIMEOUT') or '12')
# Overall limit for one diagnosis (all SSH sessions together). Measured 25.09.2026: 0.8-1.9 s on 13 Cisco switches.
# Must stay below the faq-server -> network-diag timeout (12 s).
TOTAL_TIMEOUT = float(os.getenv('SSH_TOTAL_TIMEOUT') or '10')


def _parse_nets(value):
    nets = []
    for part in (value or '').replace(';', ',').split(','):
        part = part.strip()
        if part:
            try:
                nets.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                print(f'[Network-Diag] игнорирую некорректную сеть: {part}', flush=True)
    return nets


MGMT_NETS = _parse_nets(os.getenv('SWITCH_MGMT_NETS') or '10.99.0.0/24')

print(f"[Network-Diag] v2 user={NETWORK_USER or '(empty)'} pass_len={len(NETWORK_PASS)} "
      f"enable_len={len(NETWORK_ENABLE)} mgmt_nets={[str(n) for n in MGMT_NETS]}", flush=True)

PROMPT_RE = re.compile(r'(?:^|\n)[^\s#>]{1,64}[#>]\s*$')
MORE_RE = re.compile(r'--\s*more\s*--', re.I)
INVALID_RE = re.compile(r'invalid input|incomplete command|unrecognized|%\s*error', re.I)


def host_allowed(host):
    try:
        ip = ipaddress.ip_address(str(host).strip())
    except ValueError:
        return False
    return any(ip in n for n in MGMT_NETS)


def reject(host):
    return jsonify({'error': True, 'code': 'SWITCH_NOT_ALLOWED',
                    'message': f'{host} is not a switch management address - refused'})


def _read(shell, timeout, extra_markers=()):
    """Read until the CLI prompt (or a marker). Returns (text, prompt_seen)."""
    buf = ''
    end = time.time() + timeout
    while time.time() < end:
        if shell.recv_ready():
            chunk = shell.recv(65535).decode('utf-8', errors='ignore')
            buf += chunk
            if MORE_RE.search(chunk):
                shell.send(' ')
                continue
            clean = buf.replace('\r', '')
            if any(m in buf for m in extra_markers) or PROMPT_RE.search(clean):
                return buf, True
        else:
            time.sleep(0.05)
    return buf, False


def run_ssh_session(host, commands, deadline=None):
    """One session, several commands. deadline is an absolute time.time() limit, by default
    TOTAL_TIMEOUT from the session start. Returns (outputs|None, error|None)."""
    print(f'[SSH] ==== {host}: {commands}', flush=True)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    t0 = time.time()
    if deadline is None:
        deadline = t0 + TOTAL_TIMEOUT
    timed_out = f'Switch {host} did not answer within {TOTAL_TIMEOUT:.0f}s'

    def left(limit):
        return max(0.0, min(limit, deadline - time.time()))

    try:
        conn_timeout = left(CONNECT_TIMEOUT)
        if conn_timeout <= 0:
            return None, timed_out
        client.connect(hostname=host, port=22, username=NETWORK_USER, password=NETWORK_PASS,
                       timeout=conn_timeout, banner_timeout=conn_timeout,
                       auth_timeout=conn_timeout, look_for_keys=False, allow_agent=False)
        shell = client.invoke_shell(width=250, height=1000)
        banner, ok = _read(shell, left(8))
        if not ok:
            return None, timed_out if time.time() >= deadline else f'No CLI prompt from {host}'

        if banner.rstrip().endswith('>') and NETWORK_ENABLE:
            shell.send('enable\n')
            out, _ = _read(shell, left(5), extra_markers=('assword',))
            if 'assword' in out:
                shell.send(NETWORK_ENABLE + '\n')
                out, _ = _read(shell, left(5))
            if not out.rstrip().endswith('#'):
                print('[SSH] enable не прошёл, продолжаю в user mode', flush=True)

        shell.send('terminal length 0\n')
        _read(shell, left(5))

        outputs = []
        for cmd in commands:
            shell.send(cmd + '\n')
            out, ok = _read(shell, left(CMD_TIMEOUT))
            if not ok and time.time() >= deadline:
                print(f'[SSH] общий лимит {TOTAL_TIMEOUT:.0f}s исчерпан на: {cmd}', flush=True)
                return None, timed_out
            if not ok:
                print(f'[SSH] не дождался приглашения после: {cmd}', flush=True)
            outputs.append(out)
        print(f'[SSH] готово за {time.time() - t0:.1f}s, байт={[len(o) for o in outputs]}', flush=True)
        return outputs, None

    except paramiko.AuthenticationException as e:
        return None, f'SSH authentication failed: {e}'
    except paramiko.SSHException as e:
        return None, f'SSH error: {e}'
    except socket.timeout:
        return None, f'SSH connection timeout to {host}'
    except (socket.error, OSError) as e:
        return None, f'SSH connection failed to {host}: {e}'
    except Exception as e:  # noqa: BLE001
        return None, f'SSH unexpected error: {e}'
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


def is_zte_device(device_name=None, device_type=None):
    s = f'{device_name or ""} {device_type or ""}'.lower()
    return any(k in s for k in ('zte', 'gpon', 'olt', 'c320'))


def parse_port_status(output):
    if not output or INVALID_RE.search(output):
        return None
    text = output.lower()
    if 'administratively down' in text:
        return 'down'
    if 'line protocol is up' in text:
        return 'up'
    if 'line protocol is down' in text or 'err-disabled' in text:
        return 'down'
    m = re.search(r'\bis (up|down)\b', text)   # NX-OS: "Ethernet1/1 is up"
    return m.group(1) if m else None


def diagnose_device(switch_ip, switch_name, mac_address, port, device_type):
    zte = is_zte_device(switch_name, device_type)
    dtype = 'zte' if zte else 'cisco'
    try:
        mac_norm = mac_parser.normalize_mac(mac_address)
    except ValueError:
        return {'error': True, 'message': f'Invalid MAC address: {mac_address}'}

    cmds = []
    if port and not zte:
        cmds.append(f'show interface {port}')
    cmds.append('show mac' if zte else f'show mac address-table address {mac_norm}')

    deadline = time.time() + TOTAL_TIMEOUT  # one limit for all sessions, including fallback commands
    outputs, err = run_ssh_session(switch_ip, cmds, deadline)
    if err:
        return {'error': True, 'message': err}

    port_status = parse_port_status(outputs[0]) if (port and not zte) else None
    mac_out = outputs[-1]

    if not zte and (INVALID_RE.search(mac_out) or not mac_out.strip()):
        for alt in ('show mac address-table', 'show mac-address-table'):
            alt_out, err = run_ssh_session(switch_ip, [alt], deadline)
            if err:
                return {'error': True, 'message': err}
            mac_out = alt_out[0]
            if not INVALID_RE.search(mac_out):
                break

    result = mac_parser.parse(mac_out, mac_address, switch_name, dtype)
    mac_found = result.get('found', False)
    found_port = result.get('port')

    port_match = None
    if mac_found and port and found_port:
        port_match = normalize_port(port) == normalize_port(found_port)

    if port_status == 'down':
        diagnosis = 'Port is down - echipamentul nu poate primi date'
    elif not mac_found:
        diagnosis = ('Port up but MAC not found - echipament oprit sau deconectat'
                     if port_status == 'up' else 'MAC not found on switch - echipament deconectat')
    elif port_match is False:
        diagnosis = f'MAC found on {found_port}, expected {port} - verificare necesara'
    else:
        diagnosis = result.get('diagnosis') or 'Connection OK'

    return {'error': False, 'data': {
        'device': switch_name,
        'mac_address': mac_address,
        'port': found_port or port,
        'expected_port': port,
        'port_match': port_match,
        'vlan': result.get('vlan'),
        'port_status': port_status,
        'mac_found': mac_found,
        'diagnosis': diagnosis,
    }}


def _params():
    data = request.get_json(silent=True) or {}
    switch_ip = data.get('device_ip') or data.get('switch_ip')
    switch_name = data.get('device_name') or data.get('switch_name') or switch_ip
    return data, switch_ip, switch_name


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'network-diag', 'protocol': 'ssh', 'version': 2,
                    'mgmt_nets': [str(n) for n in MGMT_NETS]})


@app.route('/diagnose', methods=['POST'])
def diagnose():
    try:
        data, switch_ip, switch_name = _params()
        mac_address = data.get('mac_address')
        if not switch_ip or not mac_address:
            return jsonify({'error': True, 'message': 'Missing parameters'})
        if not host_allowed(switch_ip):
            return reject(switch_ip)
        t0 = time.time()
        r = diagnose_device(switch_ip, switch_name, mac_address, data.get('port'),
                            data.get('device_type'))
        print(f'[diagnose] {switch_ip} за {time.time() - t0:.1f}s', flush=True)
        return jsonify(r)
    except Exception as e:  # noqa: BLE001
        print(f'[diagnose] Error: {e}', flush=True)
        return jsonify({'error': True, 'message': str(e)})


@app.route('/check-mac', methods=['POST'])
def check_mac():
    try:
        data, switch_ip, switch_name = _params()
        mac_address = data.get('mac_address')
        if not switch_ip or not mac_address:
            return jsonify({'error': True, 'message': 'Missing parameters'})
        if not host_allowed(switch_ip):
            return reject(switch_ip)
        r = diagnose_device(switch_ip, switch_name, mac_address, None, data.get('device_type'))
        if r['error']:
            return jsonify(r)
        r['data']['found'] = r['data']['mac_found']
        return jsonify(r)
    except Exception as e:  # noqa: BLE001
        return jsonify({'error': True, 'message': str(e)})


@app.route('/check-port', methods=['POST'])
def check_port():
    try:
        data, switch_ip, switch_name = _params()
        port = data.get('port')
        if not switch_ip or not port:
            return jsonify({'error': True, 'message': 'Missing parameters'})
        if not host_allowed(switch_ip):
            return reject(switch_ip)
        if is_zte_device(switch_name, data.get('device_type')):
            return jsonify({'error': False, 'data': {
                'status': None, 'diagnosis': 'Port-state check not supported for GPON yet'}})
        outputs, err = run_ssh_session(switch_ip, [f'show interface {port}'])
        if err:
            return jsonify({'error': True, 'message': err})
        status = parse_port_status(outputs[0])
        return jsonify({'error': False, 'data': {
            'status': status, 'diagnosis': f'Port is {status}' if status else 'Unknown'}})
    except Exception as e:  # noqa: BLE001
        return jsonify({'error': True, 'message': str(e)})


@app.route('/test-ssh', methods=['POST'])
def test_ssh():
    try:
        data = request.get_json(silent=True) or {}
        host = data.get('host') or data.get('switch_ip')
        if not host:
            return jsonify({'error': True, 'message': 'Host not specified'})
        if not host_allowed(host):
            return reject(host)
        t0 = time.time()
        outputs, err = run_ssh_session(host, ['show version'])
        if err:
            return jsonify({'error': True, 'message': err})
        return jsonify({'error': False, 'message': 'SSH connection successful',
                        'output_length': len(outputs[0]), 'seconds': round(time.time() - t0, 1)})
    except Exception as e:  # noqa: BLE001
        return jsonify({'error': True, 'message': str(e)})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
