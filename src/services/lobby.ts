import { MongoServerError, ObjectId, WithId } from "mongodb";
import { lobbies } from "../db.js";
import { AccessError, ArgumentError, EntityExistanceError, OverflowError } from "../errors.js";
import { LobbyDoc } from "../types/lobby.js";
import { LobbyDetailsDTO, LobbyListItemDTO } from "tfm_common/lib/dto/lobby.js";
import { UserDoc } from "../types/user.js";
import { mapUserDetails } from "../utils/map.js";
import { LongPollService } from "./longpoll.js";
import { userService } from "./user.js";
import { LobbyEvent } from "tfm_common/lib/events/lobby.js";

class LobbyService extends LongPollService<LobbyDoc, LobbyEvent> {

    async create(owner: WithId<UserDoc>, name: string, password?: string): Promise<ObjectId> {
        await this.leave(owner);
        try {
            const result = await lobbies.insertOne({
                name,
                password,
                creationTime: new Date(),
                owner: owner._id,
                members: [owner._id],
                events: [],
            });
            await userService.setStatus(owner._id, { activity: "lobby", lobbyId: result.insertedId });
            return result.insertedId;
        } catch (e) {
            if (e instanceof MongoServerError && e.code === 11000)
                throw new EntityExistanceError("lobby with given name already exists");
            throw e;
        }
    }

    async join(user: WithId<UserDoc>, id: ObjectId, password?: string) {
        await this.leave(user);
        const lobby = await lobbies.findOne({ _id: id });
        if (!lobby) throw new EntityExistanceError("there is no lobby with given id");
        if (lobby.password && lobby.password !== password) throw new AccessError("lobby password doesn't match");
        if (lobby.members.some(id => id.equals(user._id))) return;

        try {
            await lobbies.updateOne({ _id: id }, { $addToSet: { members: user._id } });
            await userService.setStatus(user._id, { activity: "lobby", lobbyId: id });
            await this.publishEvent(id, {
                type: "user_joined",
                data: {
                    user: mapUserDetails(user),
                }
            });
        } catch (e) {
            if (e instanceof MongoServerError && e.code === 121)
                throw new OverflowError("lobby is full");
            throw e;
        }
    }

    async disband(user: WithId<UserDoc>, id: ObjectId) {
        const lobby = await lobbies.findOne({ _id: id });
        if (!lobby) throw new EntityExistanceError("there is no lobby with given id");
        if (!lobby.owner.equals(user._id)) throw new AccessError("no owner access to lobby");

        await this.publishEvent(id, {
            type: "lobby_disbanded",
        });
        await userService.setStatusForMany(lobby.members, undefined);
        await this.delete(id);
    }

    async leave(user: WithId<UserDoc>) {
        if (user.status?.activity !== "lobby") return;
        const lobby = await lobbies.findOne({ _id: user.status.lobbyId });
        if (!lobby) return;

        if (lobby.members.length > 1) {
            await lobbies.updateOne({ _id: lobby._id }, {
                $pull: { members: user._id }
            });
            await userService.setStatus(user._id, undefined);
            await this.publishEvent(lobby._id, {
                type: "user_left",
                data: {
                    userId: user._id.toString(),
                }
            });
            if (lobby.owner.equals(user._id))
                await this.changeOwner(null, lobby._id, lobby.members.filter(id => !id.equals(user._id))[0]);
        } else {
            await this.delete(lobby._id);
            await userService.setStatus(user._id, undefined);
        }
    }

    async kick(user: WithId<UserDoc> | null, lobbyId: ObjectId, userId: ObjectId) {
        const lobby = await lobbies.findOne({ _id: lobbyId });
        if (!lobby) throw new EntityExistanceError("there is no lobby with given id");
        if (user && !lobby.owner.equals(user._id)) throw new AccessError("no owner access to lobby");
        if (!lobby.members.some(id => id.equals(userId))) throw new ArgumentError("there is no such member in lobby");
        
        await this.publishEvent(lobbyId, {
            type: "user_kicked",
            data: {
                userId: userId.toString(),
            }
        });
        await lobbies.updateOne({ _id: lobby._id }, {
            $pull: { members: userId }
        });
        await userService.setStatus(userId, undefined);
    }

    async changeOwner(user: WithId<UserDoc> | null, lobbyId: ObjectId, newOwnerId: ObjectId) {
        const lobby = await lobbies.findOne({ _id: lobbyId });
        if (!lobby) throw new EntityExistanceError("there is no lobby with given id");
        if (user && !lobby.owner.equals(user._id)) throw new AccessError("no owner access to lobby");
        if (!lobby.members.some(id => id.equals(newOwnerId))) throw new ArgumentError("there is no such member in lobby");

        await lobbies.updateOne({ _id: lobbyId }, { $set: { owner: newOwnerId } });
        await this.publishEvent(lobbyId, {
            type: "owner_changed",
            data: {
                newOwnerId: newOwnerId.toString(),
            }
        });
    }

    async delete(id: ObjectId) {
        await lobbies.deleteOne({ _id: id });
    }

    async get(id: ObjectId): Promise<WithId<LobbyDoc>> {
        const lobby = await lobbies.findOne({ _id: id })
        if (!lobby) throw new EntityExistanceError("there is no lobby with given id");
        return lobby;
    }

    async list(): Promise<LobbyListItemDTO[]> {
        const lobbies_ = lobbies.aggregate([
            { $lookup: {
                from: "users",
                localField: "members",
                foreignField: "_id",
                as: "memberData",
            } },
            { $addFields: { members: "$memberData" } },
            { $project: { memberData: 0 } },
            { $sort: { creationTime: -1 } }
        ]);

        const results: LobbyListItemDTO[] = [];

        for await (const lobby of lobbies_) {
            const open = !lobby.password;
            if (!open) {
                results.push({
                    open,
                    id: lobby._id.toString(),
                    name: lobby.name,
                });
            } else {
                results.push({
                    open,
                    id: lobby._id,
                    name: lobby.name,
                    owner: lobby.owner.toString(),
                    members: lobby.members.map(m => mapUserDetails(m)),
                });
            }
        }

        return results;
    }

    async getDetails(user: WithId<UserDoc>, id: ObjectId): Promise<LobbyDetailsDTO> {
        const lobby = await lobbies.aggregate([
            { $match: { _id: id } },
            { $limit: 1 },
            { $lookup: {
                from: "users",
                localField: "members",
                foreignField: "_id",
                as: "memberData",
            } },
            { $addFields: { members: "$memberData" } },
            { $project: { memberData: 0 } }
        ]).next();

        if (!lobby) throw new EntityExistanceError("there is no lobby with given id");
        if (!lobby.members.some(m => m._id.equals(user._id))) throw new AccessError("no access to lobby details");

        return {
            id: lobby._id.toString(),
            open: !lobby.password,
            name: lobby.name,
            ei: lobby.events.length,
            owner: lobby.owner.toString(),
            members: lobby.members.map(m => mapUserDetails(m)),
        };
    }

    async addEvent(id: ObjectId, event: LobbyEvent): Promise<void> {
        await lobbies.updateOne({ _id: id }, {
            $push: { events: event }
        });
    }

    extractEvents(doc: WithId<LobbyDoc>): LobbyEvent[] {
        return doc.events;
    }

    checkEventRequestRights(requestor: WithId<UserDoc>, doc: WithId<LobbyDoc>): void {
        if (!doc.members.some((m) => m.equals(requestor._id))) {
            throw new AccessError("no access to lobby events");
        }
    }
}

export const lobbyService = new LobbyService();
