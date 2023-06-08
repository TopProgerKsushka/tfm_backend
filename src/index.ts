import express from "express";
import config from "./config.js";
import bodyParser from "body-parser";
import cors from "cors";
import { auth } from "./auth.js";
import { userController } from "./controllers/user.js";
import { lobbyController } from "./controllers/lobby.js";
import { gameController } from "./controllers/game.js";

const app = express();

app.use(cors())
app.use(express.json({ type: "application/json" }));
app.use(bodyParser.raw({ type: [ "image/png", "image/jpeg" ], limit: config.fileSizeLimit }));
app.use(auth);

app.use("/api/user", userController);
app.use("/api/lobby", lobbyController);
app.use("/api/game", gameController);

function hello() {
    const host = config.server.host ?? "*"
    console.log(`Listening on ${host}:${config.server.port}`);
}

if (!config.server.host || config.server.host === "*") {
    app.listen(config.server.port, hello);
} else {
    app.listen(config.server.port, config.server.host, hello);
}
