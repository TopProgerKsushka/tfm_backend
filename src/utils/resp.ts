export function err(code: number) {
    return {
        status: "error",
        error: code,
    };
}

export function ok(data?: any) {
    if (!data)
        return { status: "ok" };
    else
        return {
            status: "ok",
            data
        };
}