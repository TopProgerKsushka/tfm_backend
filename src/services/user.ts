import { createHash } from "crypto";
import { users } from "../db.js";
import { Binary, MongoServerError, ObjectId, WithId } from "mongodb";
import { Sex, UserDoc, UserStatus } from "../types/user.js";
import { AccessError, EntityExistanceError } from "../errors.js";

class UserService {
    async register(username: string, password: string): Promise<string> {
        const passwordHash = createHash("sha256").update(password).digest("hex");
        const token =
            Math.floor(Date.now() / 1000).toString(16) +
            createHash("md5")
                .update(username + passwordHash + Math.floor(Math.random() * Number.MAX_VALUE))
                .digest("hex");

        try {
            await users.insertOne({
                username,
                passwordHash,
                roles: ["USER"],
                token,
                registrationTime: new Date(),
                personal: {},
                stats: {
                    gamesPlayed: 0,
                    gamesWon: 0,
                    elo: 0,
                },
                status: undefined,
            });

            return token;
        } catch (e) {
            if (e instanceof MongoServerError && e.code === 11000)
                throw new EntityExistanceError("user already registered");
            throw e;
        }
    }

    async login(username: string, password: string): Promise<string> {
        const user = await users.findOne({ username });
        if (!user)
            throw new EntityExistanceError("user with given username is not registered");
        if (
            !password ||
            user.passwordHash !== createHash("sha256").update(password).digest("hex")
        ) {
            throw new AccessError("the password is incorrect");
        }

        return user.token;
    }

    async get(id: ObjectId): Promise<WithId<UserDoc>> {
        const user = await users.findOne({ _id: id });
        if (!user) throw new EntityExistanceError("there is no user with given id");
        return user;
    }

    async getMany(ids: ObjectId[]): Promise<WithId<UserDoc>[]> {
        return await users.find({ _id: { $in: ids } }).toArray();
    }

    async setAvatar(id: ObjectId, mimeType: string, data: Buffer) {
        await users.updateOne({ _id: id }, {
            $set: {
                avatar: {
                    mimeType: mimeType,
                    data: new Binary(data),
                },
            },
        });
    }

    async setPersonal(id: ObjectId, sex?: Sex, about?: string) {
        await users.updateOne({ _id: id }, {
            $set: {
                personal: {
                    sex,
                    about,
                }
            },
        });
    }

    async setStatus(id: ObjectId, status: UserStatus) {
        await users.updateOne({ _id: id }, {
            $set: {
                status,
            }
        });
    }

    async setStatusForMany(ids: ObjectId[], status: UserStatus) {
        await users.updateMany({ _id: { $in: ids } }, {
            $set: {
                status
            }
        });
    }

    async applyGameResults(id: ObjectId, eloDelta: number, wonGame?: boolean) {
        await users.updateOne({ _id: id }, {
            $inc: {
                "stats.elo": eloDelta,
                "stats.gamesPlayed": 1,
                "stats.gamesWon": wonGame ? 1 : 0,
            },
            $set: {
                status: undefined,
            }
        });
    }
}

export const userService = new UserService();
