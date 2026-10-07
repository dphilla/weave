package io.github.dphilla.weave.endive;

/** Migratable host state; restore stages a target before COMMIT without external effects. */
public interface HostService {
    String name();

    byte[] snapshot();

    void restore(byte[] blob);
}
