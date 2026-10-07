package io.github.dphilla.weave.endive;

/**
 * Migratable host-function state. {@link #restore} stages a fresh, non-executing target before
 * COMMIT and must not publish externally visible effects.
 */
public interface HostService {
    String name();

    byte[] snapshot();

    void restore(byte[] blob);
}
