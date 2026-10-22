export function pathName(path: string) { return path.split(/[/\\]/).pop() ?? path; }

/** 路径归一化 key：图片身份即绝对路径，比较与 React key 都走它（见 CONTEXT.md「图片身份」）。 */
export function pathKey(path: string) { return path.replace(/\//g, "\\").toLowerCase(); }

export function samePath(left: string, right: string) { return pathKey(left) === pathKey(right); }
