package io.github.dphilla.weave.endive;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class FormatsTest {
    @Test
    void metaOfTheRustWovenCounter() {
        Meta meta = Meta.decode(Meta.section(Golden.bytes("counter.woven.wasm")));
        assertEquals(512, meta.pollPeriod);
        assertEquals(1, meta.entries.size());
        assertEquals("run", meta.entries.get(0).name);
        assertEquals(List.of(Meta.Type.I32), meta.entries.get(0).params);
        assertEquals(List.of(Meta.Type.I64), meta.entries.get(0).results);
        assertEquals(List.of("memory"), meta.memories);
        assertEquals("env", meta.imports.get(0).module);
        assertEquals("emit", meta.imports.get(0).name);
        assertEquals(Abi.FIXED, meta.controlGlobals);
        assertEquals(16, meta.resultsAreaSize);
    }

    @Test
    void rustSnapshotDecodesAndReencodesByteForByte() {
        byte[] rust = Golden.bytes("counter-7.snap.gz");
        assertArrayEquals(rust, Snapshot.decode(rust).encode());
    }

    @Test
    void corruptedOrTruncatedSnapshotsAreRejected() {
        byte[] rust = Golden.bytes("counter-7.snap.gz");
        byte[] corrupt = rust.clone();
        corrupt[corrupt.length / 2] ^= 1;
        assertThrows(FormatException.class, () -> Snapshot.decode(corrupt));
        byte[] truncated = Arrays.copyOf(rust, rust.length - 1);
        assertThrows(FormatException.class, () -> Snapshot.decode(truncated));
    }

    @Test
    void endiveCheckpointIsByteIdenticalToRust() throws Exception {
        byte[] rust = Golden.bytes("counter-7.snap.gz");
        byte[] endive =
                Golden.onGuestThread(
                        () -> {
                            WovenModule module =
                                    WovenModule.compile(Golden.bytes("counter.woven.wasm"));
                            WovenInstance instance =
                                    Node.instance(module, new Golden.Sink().out, true);
                            long[] remaining = {7};
                            instance.onPoll(() -> remaining[0]-- > 0 ? 0 : 1);
                            assertTrue(instance.call("run", Golden.COUNTER_N));
                            return instance.checkpoint().encode();
                        });
        assertArrayEquals(rust, endive);
    }

    @Test
    void endiveContinuesTheRustCheckpoint() throws Exception {
        List<String> golden = Golden.lines("counter-2000000.events");
        Golden.Sink sink = new Golden.Sink();
        Golden.onGuestThread(
                () -> {
                    WovenModule module = WovenModule.compile(Golden.bytes("counter.woven.wasm"));
                    WovenInstance instance = Node.instance(module, sink.out, false);
                    instance.restore(Snapshot.decode(Golden.bytes("counter-7.snap.gz")));
                    assertTrue(!instance.resume());
                    sink.out.println("WEAVE_DONE [" + String.join(", ", instance.results()) + "]");
                    return null;
                });
        // The Rust run emitted one event before poll 7.
        assertEquals(golden.subList(1, golden.size()), sink.events());
    }

    @Test
    void servicesAreOrderedByUtf8BytesNotUtf16() {
        String privateUse = "\uE000";
        String emoji = "\uD83D\uDE00";
        assertTrue(Bytes.UTF8_ORDER.compare(privateUse, emoji) < 0);
        assertTrue(privateUse.compareTo(emoji) > 0);
    }

    @Test
    void floatResultsPrintLikeRust() {
        // Expected strings are Rust's `{}` output; Java's toString differs on ties and subnormals.
        assertEquals("2662350.3", WovenInstance.display(Float.intBitsToFloat(0x4a227f39), true));
        assertEquals(
                "148906574030391.13",
                WovenInstance.display(Double.longBitsToDouble(0x42e0edc06e64c6e4L), false));
        assertEquals("0." + "0".repeat(44) + "1", WovenInstance.display(Float.MIN_VALUE, true));
        assertEquals("0." + "0".repeat(323) + "5", WovenInstance.display(Double.MIN_VALUE, false));
        assertEquals("100000000000000000000000", WovenInstance.display(1e23, false));
        assertEquals("0.1", WovenInstance.display(0.1f, true));
        assertEquals("-0", WovenInstance.display(-0.0, false));
        assertEquals("NaN", WovenInstance.display(Float.NaN, true));
        assertEquals("-inf", WovenInstance.display(Double.NEGATIVE_INFINITY, false));
    }

    @Test
    void framesOverTheirTypeCapAreRejectedBeforeAllocation() {
        byte[] page = new Bytes.Writer().u8(Wire.PAGE).u32(9 + Wire.WPAGE + 1).toByteArray();
        assertThrows(FormatException.class, () -> Wire.read(new ByteArrayInputStream(page)));
        byte[] control =
                new Bytes.Writer().u8(Wire.CTL_REQUEST).u32(Wire.MAX_CONTROL + 1).toByteArray();
        assertThrows(FormatException.class, () -> Wire.read(new ByteArrayInputStream(control)));
        byte[] empty = new Bytes.Writer().u8(Wire.MODULE_OK).u32(1).u8(0).toByteArray();
        assertThrows(FormatException.class, () -> Wire.read(new ByteArrayInputStream(empty)));
        byte[] unknown = new Bytes.Writer().u8(99).u32(0).toByteArray();
        assertThrows(FormatException.class, () -> Wire.read(new ByteArrayInputStream(unknown)));
    }

    @Test
    void controlJsonIsStrict() {
        assertEquals("1", ((Json.Num) Json.parseObject(Golden.utf8("{\"v\":1}")).get("v")).token);
        for (String bad :
                List.of(
                        "{\"a\":1,\"a\":2}",
                        "{\"a\":1.0}",
                        "{\"a\":1e0}",
                        "{\"a\":{}}",
                        "{\"a\":\"\\ud800\"}",
                        "{\"a\":1} x",
                        "{\"a\":01}")) {
            assertThrows(FormatException.class, () -> Json.parseObject(Golden.utf8(bad)), bad);
        }
    }
}
