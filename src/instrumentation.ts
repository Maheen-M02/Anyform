export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getRuntime } = await import('./server/runtime')
    // Starts job recovery and periodic cleanup in local mode at boot rather than on first request.
    getRuntime()
  }
}
