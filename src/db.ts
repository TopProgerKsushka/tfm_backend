import { MongoClient, MongoServerError } from "mongodb";
import config from "./config.js";
import { UserDoc } from "./types/user.js";
import { LobbyDoc } from "./types/lobby.js";
import { GameDoc } from "tfm_common/lib/game.js";

export const client = new MongoClient(config.db.connectionString);
const db = client.db();

export const users = db.collection<UserDoc>("users");
export const lobbies = await db.createCollection<LobbyDoc>("lobbies", {
    validator: {
        $jsonSchema: {
            bsonType: "object",
            properties: {
                members: {
                    bsonType: "array",
                    maxItems: 5,
                }
            }
        }
    }
}).catch(e => {
    if (e instanceof MongoServerError && e.code === 48) return db.collection<LobbyDoc>("lobbies");
    else throw e;
});
export const games = db.collection<GameDoc>("games");

await users.createIndex({ username: 1 }, { unique: true });
await users.createIndex({ token: 1 }, { unique: true });
await lobbies.createIndex({ name: 1 }, { unique: true });
