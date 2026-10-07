package io.github.dphilla.weave.endive;

/** Malformed or unsupported Weave bytes: meta, snapshot, wire frame or module. */
public final class FormatException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public FormatException(String message) {
        super(message);
    }
}
