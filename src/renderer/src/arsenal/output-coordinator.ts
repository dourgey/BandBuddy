export const nativeOutputRoutes=new Set<{prepare():Promise<void>;restore():Promise<void>}>()
export async function prepareNativeOutput():Promise<void>{await Promise.all([...nativeOutputRoutes].map(route=>route.prepare()))}
export async function restoreBrowserOutput():Promise<void>{await Promise.all([...nativeOutputRoutes].map(route=>route.restore()))}
