import { Router } from "express";
import { AuthenticatedRequest } from "../auth.js";
import { err, ok } from "../utils/resp.js";
import config from "../config.js";
import ErrorCodes from "../error_codes.js";
import { gameService } from "../services/game.js";
import { AccessError, ActionRequirementsError, ArgumentError, EntityExistanceError, FeeError, OverflowError, ResourceRelevanceError, ResourceSufficiencyError, TilePositioningError } from "../errors.js";
import { ObjectId } from "mongodb";
import { ProjectPlayError } from "tfm_common/lib/projects.js";

export const gameController = Router();

gameController.post("/start", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.lobbyId) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        const id = await gameService.create(req.user, new ObjectId(req.body.lobbyId));
        return res.send(ok({ id: id.toString() }));
    } catch (e) {
        console.error(e);
        if (e instanceof EntityExistanceError) return res.send(err(ErrorCodes.NO_SUCH_LOBBY));
        if (e instanceof AccessError) return res.send(err(ErrorCodes.YOU_ARE_NOT_LOBBY_OWNER));
        res.send(ErrorCodes.UNKNOWN_ERROR);
    }
});

gameController.post("/buy", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id || !req.body.projects) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await gameService.buy(req.user, new ObjectId(req.body.id), req.body.projects, req.body.corp);
        return res.send(ok());
    } catch (e) {
        console.error(e);
        if (e instanceof EntityExistanceError) return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError) {
            if (e.message === "game doesn't include player") return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
            if (e.message.startsWith("phase")) return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        if (e instanceof ArgumentError) {
            if (e.message === "wrong parameters") return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
            if (e.message.startsWith("corp")) return res.send(err(ErrorCodes.CORP_IS_NOT_IN_OFFER));
            if (e.message.startsWith("project")) return res.send(err(ErrorCodes.PROJECT_IS_NOT_IN_OFFER));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        if (e instanceof OverflowError) return res.send(err(ErrorCodes.ALREADY_MADE_PURCHASE));
        if (e instanceof ResourceSufficiencyError) return res.send(err(ErrorCodes.NOT_ENOUGH_RESOURCES));
        res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

gameController.post("/action", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id || !req.body.action) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await gameService.action(req.user, new ObjectId(req.body.id), req.body.action);
        return res.send(ok());
    } catch (e) {
        console.error(e);
        if (e instanceof EntityExistanceError) return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError) {
            if (e.message === "game doesn't include player") return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
            if (e.message === "your corporation obliges you to do special action as your first") return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            if (e.message.startsWith("phase") || e.message.startsWith("turn")) return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            if (e.message.startsWith("unmi")) return res.send(err(ErrorCodes.UNMI_ACTION_FOR_UNMI_PLAYER_ONLY));
            if (e.message.startsWith("inventrix") || e.message.startsWith("tharsis republic"))
                return res.send(err(ErrorCodes.CORP_SPECIAL_FIRST_ACTION));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        if (e instanceof ArgumentError) {
            if (e.message === "can't sell zero projects") return res.send(err(ErrorCodes.CANT_SELL_ZERO_PROJECTS));
            if (e.message === "can't sell project you don't own") return res.send(err(ErrorCodes.CANT_SELL_PROJECTS_YOU_DONT_OWN));
            if (e.message === "standard project index incorrect") return res.send(err(ErrorCodes.STANDARD_PROJECT_INDEX_INCORRECT));
            if (e.message === "milestone name incorrect") return res.send(err(ErrorCodes.MILESTONE_NAME_INCORRECT));
            if (e.message === "milestone can't be declared") return res.send(err(ErrorCodes.MILESTONE_CANT_BE_DECLARED));
            if (e.message === "award name incorrect") return res.send(err(ErrorCodes.AWARD_NAME_INCORRECT));
            if (e.message === "award can't be established") return res.send(err(ErrorCodes.AWARD_CANT_BE_ESTABLISHED));
            if (e.message === "can't play project you don't own") return res.send(err(ErrorCodes.CANT_PLAY_PROJECT_YOU_DONT_OWN));
            if (e.message === "can't do action of project you don't have on board") return res.send(err(ErrorCodes.CANT_DO_ACTION_OF_PROJECT_YOU_DONT_HAVE_ON_BOARD));
            if (e.message === "can't do action of not action project") return res.send(err(ErrorCodes.CANT_DO_ACTION_OF_NOT_ACTION_PROJECT));
            if (e.message === "action already done this generation") return res.send(err(ErrorCodes.ACTION_ALREADY_DONE_THIS_GEN));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        if (e instanceof ResourceSufficiencyError) return res.send(err(ErrorCodes.NOT_ENOUGH_RESOURCES));
        if (e instanceof OverflowError) {
            if (e.message === "incorrect tile position") return res.send(err(ErrorCodes.TILE_POSITION_INCORRECT));
            if (e.message.startsWith("milestone")) return res.send(err(ErrorCodes.MILESTONE_ALREADY_DECLARED));
            if (e.message.startsWith("award")) return res.send(err(ErrorCodes.AWARD_ALREADY_ESTABLISHED));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        if (e instanceof TilePositioningError) return res.send(err(ErrorCodes.BAD_TILE_POSITION));
        if (e instanceof ActionRequirementsError) {
            if (e.message.startsWith("global requirements")) return res.send(err(ErrorCodes.GLOBAL_REQUIREMENTS_ARE_NOT_SATISFIED));
            if (e.message.startsWith("secondary requirements")) return res.send(err(ErrorCodes.SECONDARY_REQUIREMENTS_ARE_NOT_SATISFIED));
            return res.send(err(ErrorCodes.ACTION_REQUIREMENTS_ARE_NOT_SATISFIED));
        }
        if (e instanceof ResourceRelevanceError) return res.send(err(ErrorCodes.CANT_PAY_WITH_THESE_RESOURCES));
        if (e instanceof FeeError) {
            if (e.message === "your fee is not enough") return res.send(err(ErrorCodes.FEE_IS_NOT_ENOUGH));
            if (e.message === "overpayment") return res.send(err(ErrorCodes.OVERPAYED));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        if (e instanceof ProjectPlayError) return res.send(err(ErrorCodes.PROJECT_PLAY_ERROR));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

gameController.post("/pass", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await gameService.pass(req.user, new ObjectId(req.body.id));
        return res.send(ok());
    } catch(e) {
        console.error(e);
        if (e instanceof EntityExistanceError) return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError) {
            if (e.message === "game doesn't include player") return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
            if (e.message.startsWith("phase") || e.message.startsWith("turn")) return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            if (e.message === "unable to pass after actions") return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

gameController.post("/skip", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await gameService.skip(req.user, new ObjectId(req.body.id));
        return res.send(ok());
    } catch(e) {
        console.error(e);
        if (e instanceof EntityExistanceError) return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError) {
            if (e.message === "game doesn't include player") return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
            if (e.message.startsWith("phase") || e.message.startsWith("turn")) return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            if (e.message === "unable to skip before actions") return res.send(err(ErrorCodes.INOPPORTUNE_ACTION));
            return res.send(err(ErrorCodes.UNKNOWN_ERROR));
        }
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

gameController.post("/chat", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.body.id || !req.body.message) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    try {
        await gameService.chat(req.user, new ObjectId(req.body.id), req.body.message);
        return res.send(ok());
    } catch (e) {
        console.error(e);
        if (e instanceof EntityExistanceError) return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError) return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

gameController.get("/get", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.query.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    const id = req.query.id.toString();
    try {
        const game = await gameService.getGameState(req.user, new ObjectId(id));
        res.send(ok(game));
    } catch (e) {
        console.error(e);
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

gameController.get("/events", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (!req.query.id) return res.send(err(ErrorCodes.PARAMETER_SET_DOESNT_MATCH_REQUEST));
    const id = req.query.id.toString();
    const ei = req.query.ei ? parseInt(req.query.ei.toString()) : 0;
    try {
        const events = await gameService.getEventsAfter(
            req.user,
            new ObjectId(id),
            ei,
            config.longPollTimeout ?? 25000,
        );
        res.send(ok({
            ei: ei + events.length,
            events
        }));
    } catch (e) {
        console.error(e);
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_GAME));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.NO_ACCESS_TO_GAME));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});
