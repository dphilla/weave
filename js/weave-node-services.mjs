const MASK64 = (1n << 64n) - 1n;
const toI64 = (value) => BigInt.asIntN(64, value & MASK64);

/**
 * Built-in Node services shared by fresh workloads and migration targets.
 * Their state layout is part of the cross-runtime wire contract:
 * count:u64 followed by sum:i64, both little-endian.
 */
export function makeEmitServices() {
  const make = (name, print) => {
    const state = { count: 0n, sum: 0n };
    return {
      state,
      imports: { env: { [name.split(".")[1]]: print(state) } },
      snapshot() {
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setBigUint64(0, state.count & MASK64, true);
        view.setBigInt64(8, toI64(state.sum), true);
        return bytes;
      },
      restore(blob) {
        if (!(blob instanceof Uint8Array) || blob.length !== 16) {
          throw new Error(`${name} service state must be exactly 16 bytes`);
        }
        const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        state.count = view.getBigUint64(0, true);
        state.sum = view.getBigInt64(8, true);
      },
    };
  };

  const services = new Map();
  services.set(
    "env.emit",
    make("env.emit", (state) => (index, hash) => {
      state.count += 1n;
      state.sum = toI64(state.sum + hash + BigInt(index));
      console.log(`EMIT ${index} ${hash}`);
    }),
  );
  services.set(
    "env.emit32",
    make("env.emit32", (state) => (value) => {
      state.count += 1n;
      state.sum = toI64(state.sum + BigInt(value));
      console.log(`EMIT32 ${value}`);
    }),
  );
  services.set(
    "env.emit64",
    make("env.emit64", (state) => (value) => {
      state.count += 1n;
      state.sum = toI64(state.sum + value);
      console.log(`EMIT64 ${value}`);
    }),
  );
  return services;
}
