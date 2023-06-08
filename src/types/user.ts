import { Binary, ObjectId } from "mongodb";

type Role = "USER" | "ADMIN";
export type Sex = "male" | "female"; // есть только два пола

type UserInLobbyStatus = {
    activity: "lobby",
    lobbyId: ObjectId,
};

type UserInGameStatus = {
    activity: "game",
    gameId: ObjectId,
};

export type UserStatus =
    | UserInLobbyStatus
    | UserInGameStatus
    | undefined;

export type UserDoc = {
    username: string,
    passwordHash: string,
    token: string,
    roles: Role[],
    registrationTime: Date,

    avatar?: {
        mimeType: string,
        data: Binary,
    },

    personal: {
        sex?: Sex,
        about?: string,
    },

    stats: {
        gamesPlayed: number,
        gamesWon: number,
        elo: number,
    },

    status: UserStatus
};
