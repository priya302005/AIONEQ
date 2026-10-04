/**
 * Wraps an async Express handler so a rejection goes to next(err)
 * instead of becoming an unhandled promise rejection.
 *
 * The wrapper preserves the wrapped function's name. Express middleware
 * is frequently introspected by name - error stacks, route-audit tests
 * (tests/authCoverage.test.mjs verifies every registered route is behind
 * `requireAuth` by reading handler names off the router stack), and
 * debugging tools all rely on it. An anonymous wrapper would report
 * every middleware as "", which makes guarded routes look unguarded.
 */
export const asyncHandler = (fn) => {
  const wrapper = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  if (fn && fn.name) {
    Object.defineProperty(wrapper, 'name', { value: fn.name, configurable: true })
  }
  return wrapper
}
