import { Request, Response, NextFunction } from "express";
import { WithId } from "mongodb";
import { UserDoc } from "./types/user.js";
import { users } from "./db.js";

const PUBLIC_GET_PATHS = [
    "/api/user/avatar",
];

const PUBLIC_POST_PATHS = [
    "/api/user/register",
    "/api/user/login",
];

export type AuthenticatedRequest = Request & { user: WithId<UserDoc> };
export type OptionallyAuthenticatedRequest = Request & { user?: WithId<UserDoc> };

export async function auth(req: Request, res: Response, next: NextFunction) {
    const token = req.header("x-auth-token");
    if (token) {
        const user = await users.findOne({ token });
        if (user) (req as AuthenticatedRequest).user = user;
        else { res.status(403).send(); return; } // 403 Forbidden
        next();
    } else {
        if (req.method === "POST" && PUBLIC_POST_PATHS.includes(req.path)) return next();
        if (req.method === "GET" && PUBLIC_GET_PATHS.includes(req.path)) return next();
        res.status(401).send(); // 401 Unauthorized
    }
}
