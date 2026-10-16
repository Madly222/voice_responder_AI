"""
MAC address parser for ZTE GPON and Cisco switches
Supports both device types with regex pattern matching
"""
import re
from typing import Dict, Optional

IFACE_RE = re.compile(r'^[A-Za-z][A-Za-z\-_]*\d+([/:._]\d+)*$')


def normalize_port(port):
    """Gi1/0/7 и GigabitEthernet1/0/7 -> gi1/0/7 (для сравнения портов)."""
    if not port:
        return None
    p = str(port).strip().lower()
    m = re.match(r'^([a-z\-]+)(.*)$', p)
    if not m:
        return p
    prefix, rest = m.group(1), m.group(2)
    short = {
        'gigabitethernet': 'gi', 'tengigabitethernet': 'te', 'fastethernet': 'fa',
        'ethernet': 'eth', 'eth': 'eth', 'port-channel': 'po', 'twentyfivegige': 'twe',
        'fortygigabitethernet': 'fo', 'hundredgige': 'hu',
    }.get(prefix, prefix)
    return short + rest


def parse_line_generic(line):
    """
    Возвращает (port, vlan) из строки MAC-таблицы любого вендора.
    Работает для:
      Cisco IOS:   10   0011.2233.4455  DYNAMIC  Gi1/0/7
      IOS 12.x:    0011.2233.4455  Dynamic  10  FastEthernet0/1
      NX-OS:     * 10   0011.2233.4455  dynamic  0  F  F  Eth1/1
      ZTE:         ec23.7b68.d754  825  Dynamic  gpon-onu_1/1/4:22  vport 1
    """
    tokens = [t for t in re.split(r'\s+', line.strip()) if t and t != '*']
    port = None
    vlan = None
    for t in tokens:
        if re.match(r'^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$', t, re.I):
            continue
        if port is None and IFACE_RE.match(t) and re.search(r'\d', t):
            port = t
            continue
        if vlan is None and t.isdigit() and 1 <= int(t) <= 4094:
            vlan = int(t)
    return port, vlan


class MACParser:
    """MAC address parser with support for ZTE GPON and Cisco switches"""
    
    def normalize_mac(self, mac: str) -> str:
        """
        Normalize MAC address to xxxx.xxxx.xxxx format (Cisco/ZTE standard)
        
        Args:
            mac: MAC address in any format (aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff, etc)
        
        Returns:
            str: Normalized MAC in xxxx.xxxx.xxxx format
        
        Raises:
            ValueError: If MAC address is invalid
        """
        # Remove all separators
        mac_clean = re.sub(r'[.:\-]', '', mac.lower())
        
        if len(mac_clean) != 12:
            raise ValueError(f"Invalid MAC length: {mac}")
        
        # Convert to Cisco/ZTE format
        return f"{mac_clean[0:4]}.{mac_clean[4:8]}.{mac_clean[8:12]}"
    
    def parse_zte_gpon(self, output: str, mac_address: str, device_name: str) -> Dict:
        """
        Parse ZTE GPON output (show mac command)
        
        Expected format:
        ec23.7b68.d754   825    Dynamic   gpon-onu_1/1/4:22         vport 1
        
        Args:
            output: Command output text
            mac_address: MAC address to search for
            device_name: Device hostname
        
        Returns:
            dict: Parsed result with found, port, vlan, diagnosis
        """
        
        print(f"[MACParser] Parsing ZTE GPON output for {mac_address}")
        
        try:
            # Normalize target MAC
            mac_normalized = self.normalize_mac(mac_address)
            print(f"[MACParser] Normalized MAC: {mac_normalized}")
        except ValueError as e:
            print(f"[MACParser] Error normalizing MAC: {e}")
            return {
                'device': device_name,
                'mac_address': mac_address,
                'found': False,
                'port': None,
                'vlan': None,
                'diagnosis': 'Invalid MAC address format'
            }
        
        # Pattern for ZTE: MAC(xxxx.xxxx.xxxx) VLAN(number) Type(word) Port(everything else)
        # ec23.7b68.d754   825    Dynamic   gpon-onu_1/1/4:22         vport 1
        zte_pattern = r'([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+(\d+)\s+\w+\s+(\S+)'
        
        for line_num, line in enumerate(output.split('\n'), 1):
            # Search for MAC in line
            if mac_normalized not in line.lower():
                continue
            
            print(f"[MACParser] Found MAC in line {line_num}: {line.strip()}")
            
            # Apply regex
            match = re.search(zte_pattern, line.lower())
            if match:
                try:
                    found_mac = match.group(1)  # MAC address
                    vlan = int(match.group(2))  # VLAN
                    port = match.group(3)       # Port
                    
                    print(f"[MACParser] Parsed successfully:")
                    print(f"  MAC: {found_mac}")
                    print(f"  VLAN: {vlan}")
                    print(f"  Port: {port}")
                    
                    return {
                        'device': device_name,
                        'mac_address': mac_address,
                        'found': True,
                        'port': port,
                        'vlan': vlan,
                        'diagnosis': f'MAC found on {port}, VLAN {vlan}'
                    }
                except Exception as e:
                    print(f"[MACParser] Parse error: {e}")
                    continue

            # Шаблон не подошёл (старый IOS, NX-OS) — разбираем по токенам
            port, vlan = parse_line_generic(line)
            if port:
                print(f"[MACParser] Универсальный разбор: port={port} vlan={vlan}")
                return {
                    'device': device_name,
                    'mac_address': mac_address,
                    'found': True,
                    'port': port,
                    'vlan': vlan,
                    'diagnosis': f'MAC found on {port}' + (f', VLAN {vlan}' if vlan else ''),
                }
            else:
                print(f"[MACParser] Regex didn't match line")
        
        print(f"[MACParser] MAC {mac_address} not found in output")
        
        return {
            'device': device_name,
            'mac_address': mac_address,
            'found': False,
            'port': None,
            'vlan': None,
            'diagnosis': 'MAC not found on switch'
        }
    
    def parse_cisco(self, output: str, mac_address: str, device_name: str) -> Dict:
        """
        Parse Cisco output (show mac address-table command)
        
        Expected formats:
        1. 100    cc2d.e0bd.a251    DYNAMIC     Gi0/1
        2. * 100    cc2d.e0bd.a251    dynamic  Gi0/1
        
        Args:
            output: Command output text
            mac_address: MAC address to search for
            device_name: Device hostname
        
        Returns:
            dict: Parsed result with found, port, vlan, diagnosis
        """
        
        print(f"[MACParser] Parsing Cisco output for {mac_address}")
        
        try:
            mac_normalized = self.normalize_mac(mac_address)
            print(f"[MACParser] Normalized MAC: {mac_normalized}")
        except ValueError as e:
            print(f"[MACParser] Error normalizing MAC: {e}")
            return {
                'device': device_name,
                'mac_address': mac_address,
                'found': False,
                'port': None,
                'vlan': None,
                'diagnosis': 'Invalid MAC address format'
            }
        
        # Pattern for Cisco: VLAN MAC Type Port
        # Can start with asterisk
        cisco_pattern = r'\*?\s*(\d+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+\w+\s+(\S+)'
        
        for line_num, line in enumerate(output.split('\n'), 1):
            if mac_normalized not in line.lower():
                continue
            
            print(f"[MACParser] Found MAC in line {line_num}: {line.strip()}")
            
            match = re.search(cisco_pattern, line.lower())
            if match:
                try:
                    vlan = int(match.group(1))
                    found_mac = match.group(2)
                    port = match.group(3)
                    if not (IFACE_RE.match(port) and re.search(r'\d', port)):
                        # Catalyst 4500/4948: между типом и портом колонка protocols
                        # (ip,ipx,assigned,other) — порт во всех форматах Cisco последний, берём его.
                        ifaces = [t for t in line.split() if IFACE_RE.match(t) and re.search(r'\d', t)]
                        if not ifaces:
                            raise ValueError(f'не найден порт в строке: {line.strip()}')
                        port = ifaces[-1]
                    
                    print(f"[MACParser] Parsed successfully:")
                    print(f"  VLAN: {vlan}")
                    print(f"  MAC: {found_mac}")
                    print(f"  Port: {port}")
                    
                    return {
                        'device': device_name,
                        'mac_address': mac_address,
                        'found': True,
                        'port': port,
                        'vlan': vlan,
                        'diagnosis': f'MAC found on {port}, VLAN {vlan}'
                    }
                except Exception as e:
                    print(f"[MACParser] Parse error: {e}")
                    continue

            # Шаблон не подошёл (старый IOS, NX-OS) — разбираем по токенам
            port, vlan = parse_line_generic(line)
            if port:
                print(f"[MACParser] Универсальный разбор: port={port} vlan={vlan}")
                return {
                    'device': device_name,
                    'mac_address': mac_address,
                    'found': True,
                    'port': port,
                    'vlan': vlan,
                    'diagnosis': f'MAC found on {port}' + (f', VLAN {vlan}' if vlan else ''),
                }
            else:
                print(f"[MACParser] Regex didn't match line")
        
        print(f"[MACParser] MAC {mac_address} not found in output")
        
        return {
            'device': device_name,
            'mac_address': mac_address,
            'found': False,
            'port': None,
            'vlan': None,
            'diagnosis': 'MAC not found on switch'
        }
    
    def parse(self, output: str, mac_address: str, device_name: str, device_type: str) -> Dict:
        """
        Main parsing method - dispatches to appropriate parser
        
        Args:
            output: Command output from show mac
            mac_address: MAC address to search for
            device_name: Device hostname
            device_type: Device type ('zte' or 'cisco')
        
        Returns:
            dict: Parsing result with found, port, vlan, diagnosis
        """
        
        print(f"[MACParser] Starting parse:")
        print(f"  Device: {device_name}")
        print(f"  Type: {device_type}")
        print(f"  MAC: {mac_address}")
        print(f"  Output length: {len(output)} chars")
        
        if device_type.lower() == 'zte':
            return self.parse_zte_gpon(output, mac_address, device_name)
        elif device_type.lower() == 'cisco':
            return self.parse_cisco(output, mac_address, device_name)
        else:
            # Default to ZTE format
            print(f"[MACParser] Unknown device type '{device_type}', trying ZTE format")
            return self.parse_zte_gpon(output, mac_address, device_name)

# Create global instance
mac_parser = MACParser()