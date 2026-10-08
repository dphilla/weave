package io.github.dphilla.weave.endive;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class PageTrackerTest {
    private static final class Mem implements PageTracker.Memories {
        byte[] bytes;

        Mem(int pages) {
            bytes = new byte[pages * Wire.WPAGE];
        }

        @Override
        public int memoryCount() {
            return 1;
        }

        @Override
        public long memoryBytes(int m) {
            return bytes.length;
        }

        @Override
        public byte[] read(int m, int offset, int length) {
            return Arrays.copyOfRange(bytes, offset, offset + length);
        }
    }

    private final List<Long> sent = new ArrayList<>();
    private final PageTracker.Sink sink = (m, page, bytes) -> sent.add(page);

    @Test
    void neverSentZeroPagesAreElided() throws Exception {
        Mem mem = new Mem(8);
        new PageTracker(1).scanFull(mem, sink);
        assertEquals(List.of(), sent);
    }

    @Test
    void onlyChangedPagesAreResentIncludingPagesThatBecomeZero() throws Exception {
        Mem mem = new Mem(8);
        PageTracker tracker = new PageTracker(1);
        mem.bytes[3 * Wire.WPAGE + 5] = 1;
        assertEquals(1, tracker.scanFull(mem, sink));
        assertEquals(0, tracker.scanFull(mem, sink));
        mem.bytes[3 * Wire.WPAGE + 5] = 0;
        assertEquals(1, tracker.scanFull(mem, sink));
        assertEquals(0, tracker.scanFull(mem, sink));
        assertEquals(List.of(3L, 3L), sent);
    }

    @Test
    void budgetBoundsAStepAndTheRoundCompletesOnTheLastPage() throws Exception {
        Mem mem = new Mem(4);
        Arrays.fill(mem.bytes, (byte) 7);
        PageTracker tracker = new PageTracker(1);
        assertFalse(tracker.scanStep(mem, 2L * Wire.WPAGE, sink));
        assertEquals(List.of(0L, 1L), sent);
        assertTrue(tracker.scanStep(mem, 2L * Wire.WPAGE, sink));
        assertEquals(List.of(0L, 1L, 2L, 3L), sent);
    }

    @Test
    void grownMemoryIsTracked() throws Exception {
        Mem mem = new Mem(2);
        PageTracker tracker = new PageTracker(1);
        tracker.scanFull(mem, sink);
        mem.bytes = Arrays.copyOf(mem.bytes, 4 * Wire.WPAGE);
        mem.bytes[3 * Wire.WPAGE] = 9;
        tracker.scanFull(mem, sink);
        assertEquals(List.of(3L), sent);
    }
}
