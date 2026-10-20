export function pathName(path: string) { return path.split(/[/\\]/).pop() ?? path; }

export function samePath(left: string, right: string) { return left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase(); }
