package io.github.dphilla.weave.endive;

import java.io.IOException;
import java.security.MessageDigest;
import java.util.Arrays;

/** Pre-copy dirty tracking as weave-host's pages.rs: 4 KiB pages, 16-byte truncated SHA-256. */
final class PageTracker {
    /** Read access to an instance's memories in meta order. */
    interface Memories {
        int memoryCount();

        long memoryBytes(int memory);

        byte[] read(int memory, int offset, int length);
    }

    interface Sink {
        void page(int memory, long pageNo, byte[] bytes) throws IOException;
    }

    private static final int DIGEST = 16;
    private static final byte[] ZERO_PAGE = new byte[Wire.WPAGE];

    // An all-zero slot means "known zero and never sent", so a grown table starts correct.
    private final byte[][] digests;
    private final MessageDigest sha = Bytes.sha256();
    private int cursorMemory;
    private long cursorPage;

    PageTracker(int memories) {
        digests = new byte[memories][0];
    }

    /** Scans up to budget bytes from the cursor; true when a full pass completed. */
    boolean scanStep(Memories mems, long budget, Sink sink) throws IOException {
        for (long scanned = 0; ; ) {
            if (cursorMemory >= mems.memoryCount()) {
                cursorMemory = 0;
                cursorPage = 0;
                return true;
            }
            if (cursorPage >= pages(mems, cursorMemory)) {
                cursorMemory++;
                cursorPage = 0;
            } else if (scanned >= budget) {
                return false;
            } else {
                visit(mems, cursorMemory, cursorPage++, sink);
                scanned += Wire.WPAGE;
            }
        }
    }

    /** One full pass for the stop-and-copy delta; returns the pages sent. */
    long scanFull(Memories mems, Sink sink) throws IOException {
        long sent = 0;
        for (int m = 0; m < mems.memoryCount(); m++) {
            for (long p = 0, pages = pages(mems, m); p < pages; p++) {
                sent += visit(mems, m, p, sink) ? 1 : 0;
            }
        }
        return sent;
    }

    private long pages(Memories mems, int m) {
        long pages = mems.memoryBytes(m) / Wire.WPAGE;
        if (digests[m].length < pages * DIGEST) {
            digests[m] = Arrays.copyOf(digests[m], (int) (pages * DIGEST));
        }
        return pages;
    }

    private boolean visit(Memories mems, int m, long page, Sink sink) throws IOException {
        byte[] buf = mems.read(m, (int) (page * Wire.WPAGE), Wire.WPAGE);
        int at = (int) (page * DIGEST);
        if (Arrays.equals(digests[m], at, at + DIGEST, ZERO_PAGE, 0, DIGEST)
                && Arrays.equals(buf, ZERO_PAGE)) {
            return false;
        }
        byte[] digest = sha.digest(buf);
        if (Arrays.equals(digest, 0, DIGEST, digests[m], at, at + DIGEST)) {
            return false;
        }
        System.arraycopy(digest, 0, digests[m], at, DIGEST);
        sink.page(m, page, buf);
        return true;
    }
}
