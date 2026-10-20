'use strict';
// "Apply" based on reality: which services run with stale .env values and what else needs doing.
//
// A service is stale if a variable in the running container (docker inspect) differs from
// what .env would produce now (environment/ports lines in compose). This also catches .env edits
// made outside the panel. Values are never exposed, only variable names.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT_DIR = process.env.PROJECT_DIR || '/project';
const COMPOSE_FILES = (process.env.COMPOSE_FILES || 'docker-compose-ultravox.yml:docker-compose-admin-panel.yml').split(':');
const SELF = 'admin-panel';
// Restarting these services drops calls in progress.
const CALL_SERVICES = ['avr-core', 'avr-core-ru', 'avr-sts-ultravox', 'avr-sts-ultravox-ru', 'avr-asterisk', 'avr-ami'];
// Ultravox tools depend on these keys; changing them requires a tool sync.
const TOOL_KEYS = ['TOOLS_PUBLIC_URL', 'TOOLS_API_KEY', 'BILLING_PROVIDER', 'NETWORK_SOURCE',
  'COMPANY_NAME', 'CLIENT_ID_LABEL', 'CLIENT_ID_FORMAT'];

// docker compose prefers process environment variables over .env, and the panel itself runs with PANEL_*,
// CRON_TZ etc., so compose is run with a clean environment; otherwise stale values would be substituted.
const CLEAN_ENV = () => ({ PATH: process.env.PATH, HOME: process.env.HOME || '/root' });

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: PROJECT_DIR, timeout, maxBuffer: 8 * 1024 * 1024, env: CLEAN_ENV() }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-1500)));
      resolve(stdout);
    });
  });
}
const composeArgs = () => ['compose', '--env-file', '.env', ...COMPOSE_FILES.flatMap((f) => ['-f', f])];

// Interpolation as in compose: ${V}, ${V:-def}, ${V-def}, $V.
function interpolate(tpl, env) {
  return tpl.replace(/\$\{(\w+)(?:(:?)-([^}]*))?\}|\$(\w+)/g, (m, v, colon, def, bare) => {
    const name = v || bare;
    const val = env[name];
    if (def !== undefined) return (colon ? (val === undefined || val === '') : val === undefined) ? def : val;
    return val === undefined ? '' : val;
  });
}
const varsIn = (s) => [...s.matchAll(/\$\{(\w+)[^}]*\}|\$(\w+)/g)].map((m) => m[1] || m[2]);

// From the compose files: environment lines (NAME=template) and ports for each service.
function parseCompose() {
  const services = {};
  for (const f of COMPOSE_FILES) {
    const p = path.join(PROJECT_DIR, f);
    if (!fs.existsSync(p)) continue;
    let inServices = false, svc = null, section = null;
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
      const line = raw.replace(/\s+#.*$/, '');
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (/^\S/.test(line)) { inServices = false; svc = null; continue; }
      if (!inServices) continue;
      let m;
      if ((m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/))) { svc = m[1]; section = null; services[svc] = services[svc] || { env: [], ports: [] }; continue; }
      if (!svc) continue;
      if ((m = line.match(/^ {4}([a-z_]+):/))) { section = m[1]; continue; }
      if ((m = line.match(/^ {6}- ["']?(.+?)["']?\s*$/))) {
        if (section === 'environment') {
          const eq = m[1].indexOf('=');
          if (eq > 0) services[svc].env.push({ name: m[1].slice(0, eq), tpl: m[1].slice(eq + 1) });
        } else if (section === 'ports') services[svc].ports.push(m[1]);
      }
    }
  }
  return services;
}

async function inspect(service) {
  const ids = (await run('docker', [...composeArgs(), 'ps', '-q', service])).trim().split('\n').filter(Boolean);
  if (!ids.length) return null;
  const [info] = JSON.parse(await run('docker', ['inspect', ids[0]]));
  const env = {};
  for (const kv of info.Config.Env || []) { const i = kv.indexOf('='); env[kv.slice(0, i)] = kv.slice(i + 1); }
  return { env, ports: info.HostConfig.PortBindings || {} };
}

// Services that need a restart, and which of their variables are stale.
async function staleServices(env) {
  const out = [];
  for (const [service, def] of Object.entries(parseCompose())) {
    const uses = def.env.some((e) => varsIn(e.tpl).length) || def.ports.some((p) => varsIn(p).length);
    if (!uses) continue;
    const live = await inspect(service).catch(() => null);
    if (!live) { out.push({ service, vars: [], notRunning: true }); continue; }
    const vars = new Set();
    for (const e of def.env) {
      const refs = varsIn(e.tpl);
      if (refs.length && interpolate(e.tpl, env) !== (live.env[e.name] ?? '')) refs.forEach((v) => vars.add(v));
    }
    for (const p of def.ports) {
      const refs = varsIn(p);
      if (!refs.length) continue;
      const parts = interpolate(p, env).split(':');           // host-ip:host-port:container-port
      const [hostIp, hostPort, cport] = parts.length === 3 ? parts : ['0.0.0.0', parts[0], parts[1]];
      const b = (live.ports[`${cport}/tcp`] || [])[0] || {};
      if ((b.HostIp || '0.0.0.0') !== hostIp || String(b.HostPort) !== String(hostPort)) refs.forEach((v) => vars.add(v));
    }
    if (vars.size) out.push({ service, vars: [...vars].sort() });
  }
  return out;
}

async function plan(env, uvTools) {
  const stale = await staleServices(env);
  let tools = { needed: false, plan: [], error: null };
  if (env.ULTRAVOX_API_KEY) {
    try { const t = await uvTools.sync(env, { dryRun: true }); tools = { needed: t.plan.length > 0, plan: t.plan, error: null }; }
    catch (e) { tools.error = e.message; }
  }
  return {
    services: stale.map((s) => ({ ...s, dropsCalls: CALL_SERVICES.includes(s.service), self: s.service === SELF })),
    tools,
    toolKeysNote: TOOL_KEYS,
  };
}

// The panel cannot recreate itself: compose running inside its container dies with the old
// container and the new one is left half-created. So recreation is done by a separate short-lived
// container from the same image (docker-cli + compose), with the image's clean environment and none of the panel's values.
async function recreateSelf({ build = false } = {}) {
  const [me] = JSON.parse(await run('docker', ['inspect', require('os').hostname()]));
  const compose = ['docker', ...composeArgs(), 'up', '-d', ...(build ? ['--build'] : []), '--force-recreate', SELF]
    .map((a) => `'${a.replace(/'/g, "'\''")}'`).join(' ');
  await run('docker', ['run', '--rm', '-d', '--name', `avr-panel-restarter-${Date.now()}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${PROJECT_DIR}:${PROJECT_DIR}`, '-w', PROJECT_DIR,
    '--entrypoint', 'sh', me.Image, '-c', `sleep 2; ${compose}`]);
}

// Run: services (except the panel) -> tools -> panel (in a separate container, after the response).
async function execute(env, uvTools, { log = console.log } = {}) {
  const p = await plan(env, uvTools);
  const services = p.services.filter((s) => !s.self).map((s) => s.service);
  const result = { restarted: [], tools: null, panelRestarting: false, output: '' };
  if (services.length) {
    result.output = (await run('docker', [...composeArgs(), 'up', '-d', ...services], 300000)).slice(-3000);
    result.restarted = services;
    log(`[apply] пересозданы: ${services.join(', ')}`);
  }
  if (p.tools.needed) {
    const r = await uvTools.sync(env);
    result.tools = { done: r.done, log: r.log, problems: r.problems };
    log(`[apply] тулзы синхронизированы: ${(r.log || []).join('; ')}`);
  }
  if (p.services.some((s) => s.self)) {
    await recreateSelf();
    result.panelRestarting = true;
    log('[apply] панель будет пересоздана вспомогательным контейнером');
  }
  return result;
}

module.exports = { plan, execute, parseCompose, interpolate, CLEAN_ENV, recreateSelf };
