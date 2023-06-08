import { Router } from "express";
import { ObjectId } from "mongodb";
import { AuthenticatedRequest } from "../auth.js";
import config from "../config.js";
import ErrorCodes from "../error_codes.js";
import { AccessError, ArgumentError, EntityExistanceError, OverflowError } from "../errors.js";
import { lobbyService } from "../services/lobby.js";
import { err, ok } from "../utils/resp.js";

export const lobbyController = Router();

lobbyController.post("/create", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.name) return res.send(err(ErrorCodes.BAD_LOBBY_NAME));
    try {
        const id = await lobbyService.create(req.user, req.body.name, req.body.password);
        res.send(ok({
            id,
        }));
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.LOBBY_ALREADY_EXISTS));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

lobbyController.post("/join", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await lobbyService.join(req.user, new ObjectId(req.body.id), req.body.password);
        res.send(ok());
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.LOBBY_PASSWORD_DOESNT_MATCH));
        if (e instanceof OverflowError)
            return res.send(err(ErrorCodes.LOBBY_IS_FULL));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

lobbyController.post("/disband", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await lobbyService.disband(req.user, new ObjectId(req.body.id));
        res.send(ok());
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.YOU_ARE_NOT_LOBBY_OWNER));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

lobbyController.post("/leave", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    await lobbyService.leave(req.user);
    res.send(ok());
});

lobbyController.post("/kick", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    if (!req.body.userId) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await lobbyService.kick(
            req.user,
            new ObjectId(req.body.id),
            new ObjectId(req.body.userId)
        );
        res.send(ok());
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.YOU_ARE_NOT_LOBBY_OWNER));
        if (e instanceof ArgumentError)
            return res.send(err(ErrorCodes.NO_SUCH_USER_IN_LOBBY));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

lobbyController.post("/change_owner", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    if (!req.body.newOwnerId) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await lobbyService.changeOwner(
            req.user,
            new ObjectId(req.body.id),
            new ObjectId(req.body.newOwnerId)
        );
        res.send(ok());
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.YOU_ARE_NOT_LOBBY_OWNER));
        if (e instanceof ArgumentError)
            return res.send(err(ErrorCodes.NO_SUCH_USER_IN_LOBBY));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

lobbyController.get("/list", async (_req, res) => {
    const lobbies = await lobbyService.list();
    res.send(ok({
        lobbies
    }));
});

lobbyController.get("/get", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.query.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    const id = req.query.id.toString();
    try {
        const lobby = await lobbyService.getDetails(req.user, new ObjectId(id));
        res.send(ok(lobby));
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.NO_ACCESS_TO_LOBBY));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

lobbyController.get("/events", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.query.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    const id = req.query.id.toString();
    const ei = req.query.ei ? parseInt(req.query.ei.toString()) : 0;
    try {
        const events = await lobbyService.getEventsAfter(
            req.user,
            new ObjectId(id),
            ei,
            config.longPollTimeout ?? 25000
        );
        res.send(ok({
            ei: ei + events.length,
            events
        }));
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.NO_ACCESS_TO_LOBBY));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});
