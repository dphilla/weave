package io.github.dphilla.weave.endive;

/** Malformed or unsupported Weave bytes: meta, snapshot, frame or module. */
final class FormatException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    FormatException(String message) {
        super(message);
    }
}
