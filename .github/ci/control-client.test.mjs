// Adversarial process-level CLI tests. No guest executes and all peers are
// disposable loopback listeners. Run after building weave, e.g.
// WEAVE_BIN=target/release/weave node --test .github/ci/control-client.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(root, process.env.WEAVE_BIN || 'target/debug/weave');
const epoch = '0123456789abcdef0123456789abcdef';
const target = '127.0.0.1:9002';
const id = 'adversarial-client-operation';
const features = ['multi_memory', 'simd', 'reference_types', 'bulk_memory', 'multi_value',
  'sign_extension', 'saturating_float_to_int', 'extended_const', 'tail_call', 'memory64',
  'threads', 'exceptions', 'gc', 'relaxed_simd', 'function_references'];
const capabilities = () => ({
  runtime: 'test-peer', adapter_version: '0.1.0', migration_protocol: 2,
  services: ['env.emit', 'env.emit32', 'env.emit64'],
  imports: [
    { module: 'env', name: 'emit', params: ['i32', 'i64'], results: [] },
    { module: 'env', name: 'emit32', params: ['i32'], results: [] },
    { module: 'env', name: 'emit64', params: ['i64'], results: [] },
  ],
  features,
  limits: { control_frame_bytes: 65536, retained_operations: 256,
    operation_id_bytes: 128, memory_bytes: 1073741824, module_bytes: 536870912 },
});
function status(caps = capabilities()) {
  return { schema_version: 1, ok: true, code: 'STATUS_OK', message: 'status',
    node_epoch: epoch, lifecycle: 'running', ownership: 'retained', retry: 'never',
    operation: null, capabilities: caps };
}
function operation(request, code = 'MIGRATED') {
  const pending = code === 'ACCEPTED' || code === 'COMMIT_PENDING';
  const retired = code !== 'ACCEPTED';
  return { schema_version: 1, ok: true, code, message: 'test result', node_epoch: epoch,
    lifecycle: retired ? 'retired' : 'migrating', ownership: retired ? 'retired' : 'retained',
    retry: code === 'COMMIT_PENDING' ? 'inspect_ownership' : pending ? 'same_operation' : 'never',
    operation: { operation_id: request.operation_id, target: request.target || target,
      state: pending ? 'accepted' : 'succeeded', code, message: 'test result',
      ownership: retired ? 'retired' : 'retained',
      retry: code === 'COMMIT_PENDING' ? 'inspect_ownership' : pending ? 'same_operation' : 'never' },
    capabilities: null };
}
function packet(value, type = 24) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
function reply(socket, value) { socket.end(packet(value)); }

async function cli(args) {
  const started = performance.now();
  const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 8000);
  try {
    const { code, signal } = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    assert.equal(timedOut, false, `CLI exceeded watchdog: ${args.join(' ')}\n${stderr}`);
    assert.equal(signal, null, `CLI unexpectedly terminated: ${stderr}`);
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, `JSON command must emit exactly one document: ${stdout}\n${stderr}`);
    const value = JSON.parse(lines[0]);
    assert.equal(value.schema_version, 1);
    return { code, value, elapsed: performance.now() - started, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}

async function withPeer(onRequest, run) {
  const sockets = new Set();
  const requests = [];
  const failures = [];
  const timers = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let bytes = Buffer.alloc(0), handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt32LE(1)) return;
      handled = true;
      try {
        assert.equal(bytes[0], 23, 'client silently fell back to a legacy frame');
        const request = JSON.parse(bytes.subarray(5).toString());
        requests.push(request);
        onRequest(socket, request, requests, callback => {
          const timer = setTimeout(() => { timers.delete(timer); callback(); }, callback.delay);
          timers.add(timer);
        });
      } catch (error) {
        failures.push(error);
        socket.destroy();
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    await run(`127.0.0.1:${server.address().port}`, requests, timers);
    assert.deepEqual(failures, []);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}
function migrateArgs(node, extra = []) {
  return ['migrate', '--node', node, '--to', target, '--operation-id', id,
    '--node-epoch', epoch, '--timeout-ms', '1000', '--json', ...extra];
}

for (const [name, mutate] of [
  ['wrong operation ID', result => { result.operation.operation_id = 'another-operation'; }],
  ['wrong epoch', result => { result.node_epoch = 'f'.repeat(32); }],
  ['wrong target', result => { result.operation.target = '127.0.0.1:9003'; }],
  ['missing successful operation', result => { result.operation = null; }],
  ['inconsistent terminal state', result => { result.operation.state = 'accepted'; }],
  ['unretired successful source', result => { result.operation.ownership = 'retained'; }],
  ['retired pre-commit failure', result => {
    result.ok = false;
    result.code = result.operation.code = 'MIGRATION_FAILED';
    result.operation.state = 'failed';
    result.retry = result.operation.retry = 'new_operation';
  }],
  ['unsafe retry for confirmed handoff', result => { result.operation.retry = 'new_operation'; }],
]) {
  test(`CLI rejects ${name} without executing a fallback request`, async () => {
    await withPeer((socket, request) => {
      if (request.action === 'status') return reply(socket, status());
      const result = operation(request);
      mutate(result);
      reply(socket, result);
    }, async (node, requests) => {
      const result = await cli(migrateArgs(node));
      assert.equal(result.code, 5);
      assert.equal(result.value.code, 'DELIVERY_UNCERTAIN');
      assert.equal(result.value.operation_id, id);
      assert.equal(result.value.node_epoch, epoch);
      assert.deepEqual(requests.map(request => request.action), ['status', 'migrate']);
    });
  });
}

test('slow-drip response cannot reset the total control deadline', async () => {
  await withPeer((socket, request, _requests, schedule) => {
    const bytes = packet(status());
    let offset = 0;
    const drip = () => {
      if (socket.destroyed || offset === bytes.length) return;
      socket.write(bytes.subarray(offset, ++offset));
      drip.delay = 25;
      schedule(drip);
    };
    drip();
  }, async node => {
    const result = await cli(['status', '--node', node, '--timeout-ms', '150', '--json']);
    assert.equal(result.code, 4);
    assert.equal(result.value.code, 'CONTROL_UNAVAILABLE');
    assert.ok(result.elapsed < 1200, `slow drip stretched deadline to ${result.elapsed}ms`);
  });
});

test('oversized response length rejects without waiting for its missing payload', async () => {
  await withPeer(socket => {
    const header = Buffer.alloc(5);
    header[0] = 24;
    header.writeUInt32LE(65537, 1);
    socket.write(header);
  }, async node => {
    const result = await cli(['status', '--node', node, '--timeout-ms', '2000', '--json']);
    assert.equal(result.value.code, 'CONTROL_UNAVAILABLE');
    assert.match(result.value.message, /65536-byte limit/);
    assert.ok(result.elapsed < 1200, `client waited for oversized payload: ${result.elapsed}ms`);
  });
});

test('lost initial acknowledgement returns the exact generated operation identity', async () => {
  await withPeer((socket, request) => {
    if (request.action === 'status') return reply(socket, status());
    socket.destroy();
  }, async (node, requests) => {
    const result = await cli(['migrate', '--node', node, '--to', target, '--json', '--timeout-ms', '500']);
    assert.equal(result.code, 5);
    assert.equal(result.value.code, 'DELIVERY_UNCERTAIN');
    assert.equal(requests.length, 2);
    assert.match(result.value.operation_id, /^cli-[0-9a-f]{32}$/);
    assert.equal(result.value.operation_id, requests[1].operation_id);
    assert.equal(result.value.node_epoch, requests[1].node_epoch);
    assert.equal(result.value.target, target);
    assert.equal(result.value.ownership, 'unknown');
    assert.equal(result.value.retry, 'same_operation');
  });
});

test('query timeout preserves an observed retired source and operation record', async () => {
  await withPeer((socket, request) => {
    if (request.action === 'status') return reply(socket, status());
    if (request.action === 'migrate') return reply(socket, operation(request, 'COMMIT_PENDING'));
    // Deliberately keep the lookup open beyond the caller's total deadline.
  }, async (node, requests) => {
    const args = migrateArgs(node);
    args[args.indexOf('1000')] = '400';
    const result = await cli(args);
    assert.equal(result.code, 6);
    assert.equal(result.value.code, 'WAIT_TIMEOUT');
    assert.equal(result.value.ownership, 'retired');
    assert.equal(result.value.retry, 'inspect_ownership');
    assert.equal(result.value.operation.operation_id, id);
    assert.equal(result.value.operation.code, 'COMMIT_PENDING');
    assert.equal(result.value.operation.ownership, 'retired');
    assert.deepEqual(requests.map(request => request.action), ['status', 'migrate', 'operation']);
    assert.ok(result.elapsed < 1400);
  });
});

test('near-expired wait preserves retirement without starting another query', async () => {
  await withPeer((socket, request, _requests, schedule) => {
    if (request.action === 'status') return reply(socket, status());
    const answer = () => reply(socket, operation(request, 'COMMIT_PENDING'));
    answer.delay = 120;
    schedule(answer);
  }, async (node, requests) => {
    const args = migrateArgs(node);
    args[args.indexOf('1000')] = '200';
    const result = await cli(args);
    assert.equal(result.code, 6);
    assert.equal(result.value.code, 'WAIT_TIMEOUT');
    assert.equal(result.value.ownership, 'retired');
    assert.equal(result.value.retry, 'inspect_ownership');
    assert.deepEqual(requests.map(request => request.action), ['status', 'migrate']);
  });
});

for (const mode of ['disconnect', 'different target']) {
  test(`later ${mode} preserves the last accepted identity without resubmitting`, async () => {
    await withPeer((socket, request) => {
      if (request.action === 'status') return reply(socket, status());
      if (request.action === 'migrate') return reply(socket, operation(request, 'COMMIT_PENDING'));
      if (mode === 'disconnect') return socket.destroy();
      const result = operation(request);
      result.operation.target = '127.0.0.1:9999';
      reply(socket, result);
    }, async (node, requests) => {
      const result = await cli(migrateArgs(node));
      assert.equal(result.code, 5);
      assert.equal(result.value.code, 'OBSERVATION_UNCERTAIN');
      assert.equal(result.value.operation.operation_id, id);
      assert.equal(result.value.operation.target, target);
      assert.equal(result.value.operation.code, 'COMMIT_PENDING');
      assert.equal(result.value.operation.ownership, 'retired');
      assert.equal(result.value.retry, 'inspect_ownership');
      assert.deepEqual(requests.map(request => request.action), ['status', 'migrate', 'operation']);
    });
  });
}

test('unsupported legacy status response never triggers automatic legacy mutation', async () => {
  await withPeer(socket => {
    const message = Buffer.from('running');
    const bytes = Buffer.alloc(9 + message.length);
    bytes[0] = 19;
    bytes.writeUInt32LE(4 + message.length, 1);
    bytes.writeUInt32LE(message.length, 5);
    message.copy(bytes, 9);
    socket.end(bytes);
  }, async (node, requests) => {
    const result = await cli(migrateArgs(node));
    assert.equal(result.code, 4);
    assert.equal(result.value.code, 'CONTROL_UNAVAILABLE');
    assert.deepEqual(requests.map(request => request.action), ['status']);
  });
});

for (const [name, mutate] of [
  ['extra service', caps => caps.services.push('custom')],
  ['missing service', caps => caps.services.pop()],
  ['duplicate service', caps => caps.services.push('env.emit')],
  ['unknown service set', caps => { caps.services = null; }],
]) {
  test(`preflight rejects ${name} without executing or reserving the target`, async () => {
    await withPeer((socket, request) => {
      assert.equal(request.action, 'status');
      const caps = capabilities();
      mutate(caps);
      reply(socket, status(caps));
    }, async (node, requests) => {
      const result = await cli(['inspect', 'guests/counter.wat', '--node', node, '--json']);
      assert.equal(result.code, 3);
      assert.equal(result.value.code, 'PREFLIGHT_BLOCKED');
      assert.ok(result.value.findings.length > 0);
      assert.deepEqual(requests.map(request => request.action), ['status']);
    });
  });
}
