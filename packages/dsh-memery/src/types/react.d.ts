// 最小 react 类型声明：构建时 react 由宿主 shell 提供（external），
// 这里只满足 tsc 的模块解析。
declare module 'react' {
  export const createElement: (...args: any[]) => any
  export const useState: <T>(init: T | (() => T)) => [T, (v: T | ((p: T) => T)) => void]
  export const useEffect: (f: () => unknown, deps?: unknown[]) => void
  export const useCallback: <F extends (...a: any[]) => any>(f: F, deps?: unknown[]) => F
  export const useMemo: <T>(f: () => T, deps?: unknown[]) => T
  export const useRef: <T>(init: T) => { current: T }
  export type ReactElement = any
  export type ChangeEvent<T = any> = any
  export const Fragment: any
}
