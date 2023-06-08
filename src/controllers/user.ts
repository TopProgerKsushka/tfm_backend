import bytes from "bytes";
import { Router } from "express";
import { fileTypeFromBuffer } from "file-type";
import { ObjectId } from "mongodb";
import { AuthenticatedRequest, OptionallyAuthenticatedRequest } from "../auth.js";
import config from "../config.js";
import ErrorCodes from "../error_codes.js";
import { userService } from "../services/user.js";
import { mapUserDetails } from "../utils/map.js";
import { err, ok } from "../utils/resp.js";
import { AccessError, EntityExistanceError } from "../errors.js";

const USERNAME_REGEX: RegExp = /[a-zA-Z][a-zA-Z0-9_]+/s;
const PASSWORD_REGEX: RegExp = eval(config.passwordRegex);

export const userController = Router();

userController.post("/register", async (req, res) => {
    if (!req.body.username || !USERNAME_REGEX.test(req.body.username))
        return res.send(err(ErrorCodes.BAD_USERNAME));
    if (!req.body.password || !PASSWORD_REGEX.test(req.body.password))
        return res.send(err(ErrorCodes.BAD_PASSWORD));

    try {
        const token = await userService.register(req.body.username, req.body.password);
        res.send(ok({ token }));
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.USERNAME_ALREADY_REGISTERED));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

userController.post("/login", async (req, res) => {
    try {
        const token = await userService.login(req.body.username, req.body.password);
        res.send(ok({ token }));
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.USERNAME_NOT_REGISTERED));
        if (e instanceof AccessError)
            return res.send(err(ErrorCodes.PASSWORD_INCORRECT));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

userController.get("/get", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (req.query.id === undefined)
        return res.send(ok(mapUserDetails(req.user)));
    
    try {
        const user = await userService.get(new ObjectId(req.query.id.toString()))
        res.send(ok(mapUserDetails(user)));
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.send(err(ErrorCodes.NO_SUCH_USER));
        return res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

userController.get("/avatar", async (_req, res) => {
    const req = _req as OptionallyAuthenticatedRequest;

    try {
        const user = req.query.id !== undefined
            ? await userService.get(new ObjectId(req.query.id.toString()))
            : req.user;
        if (user?.avatar)
            return res.header("Content-Type", user.avatar.mimeType).send(user.avatar.data.buffer);
        else
            throw new EntityExistanceError();
    } catch (e) {
        if (e instanceof EntityExistanceError)
            return res.header("Content-Type", "image/png").status(404).send();
        return res.header("Content-Type", "image/png").status(500).send();
    }
});

userController.post("/avatar", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    const contentType = req.header("Content-Type");
    if (!config.avatar.allowedFormats.includes(contentType))
        return res.send(err(ErrorCodes.BAD_AVATAR_FORMAT));
    if (req.body.length > bytes(config.avatar.maximumSize))
        return res.send(err(ErrorCodes.AVATAR_TOO_LARGE));
    const type = await fileTypeFromBuffer(req.body);
    if (type?.mime !== contentType)
        return res.send(err(ErrorCodes.AVATAR_FORMAT_DOESNT_MATCH_CONTENT_TYPE));

    try {
        userService.setAvatar(req.user._id, type!.mime, req.body);
        res.send(ok());
    } catch (e) {
        res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});

userController.post("/personal", async (_req, res) => {
    const req = _req as AuthenticatedRequest;
    if (![undefined, "male", "female"].includes(req.body.sex))
        return res.send(err(ErrorCodes.BAD_SEX));
    
    try {
        await userService.setPersonal(req.user._id, req.body.sex, req.body.about);
        res.send(ok());
    } catch (e) {
        res.send(err(ErrorCodes.UNKNOWN_ERROR));
    }
});
