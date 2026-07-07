declare module "signals" {
  class Signal<T extends (...args: any[]) => void = (...args: any[]) => void> {
    active: boolean
    memorize: boolean
    add(listener: T, listenerContext?: any, priority?: number): unknown
    addOnce(listener: T, listenerContext?: any, priority?: number): unknown
    remove(listener: T, context?: any): T | undefined
    removeAll(): void
    has(listener: T, context?: any): boolean
    getNumListeners(): number
    halt(): void
    dispatch(...params: Parameters<T>): void
    forget(): void
    dispose(): void
  }

  const signals: { Signal: typeof Signal }
  export default signals
  export { Signal }
}
