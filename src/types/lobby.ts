import { ObjectId } from "mongodb";
import { LobbyEvent } from "tfm_common/lib/events/lobby.js";

export type LobbyDoc = {
    name: string,
    password?: string,
    creationTime: Date,
    owner: ObjectId,
    members: ObjectId[],
    events: LobbyEvent[],
};
