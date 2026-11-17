export async function register() {
  // ponytail: Node-only code lives in its own module behind this conditional import so the
  // Edge compile drops it (an early `return` alone still bundles node:child_process and warns).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
