import { ObjectId, WithId } from "mongodb";
import { Action, DoProjectAction, PlayHandAction, StandardProjectAction } from "tfm_common/lib/action.js";
import { CORP_STATIC } from "tfm_common/lib/corps.js";
import { GameResults, GameStateDTO, LabelsData, MilestonesData } from "tfm_common/lib/dto/game.js";
import { GameEvent } from "tfm_common/lib/events/game.js";
import { FIELD_CELL_STATIC, FieldContents } from "tfm_common/lib/field.js";
import { GameDoc, PlayerDetails } from "tfm_common/lib/game.js";
import { standardCityPredicate, standardGreeneryPredicate, standardOceanPredicate } from "tfm_common/lib/predicates.js";
import { PROJECT_STATIC } from "tfm_common/lib/projects.js";
import { Tile } from "tfm_common/lib/tiles.js";
import { AwardName, LabelName, MilestoneName, ResourceName } from "tfm_common/lib/string_types.js";
import { games } from "../db.js";
import { AccessError, ActionRequirementsError, ArgumentError, EntityExistanceError, FeeError, OverflowError, ResourceRelevanceError, ResourceSufficiencyError, TilePositioningError } from "../errors.js";
import { UserDoc } from "../types/user.js";
import { removeFromArray, shuffleArray } from "../utils/arrays.js";
import { lobbyService } from "./lobby.js";
import { LongPollService } from "./longpoll.js";
import { userService } from "./user.js";
import { mapUserDetails } from "../utils/map.js";

type AwardWinners = Partial<Record<AwardName, { top1: number[], top2: number[] }> >;

const INITIAL_LABELS: LabelsData = {
    building: 0, space: 0,
    energy: 0, science: 0,
    jupiter: 0, earth: 0,
    microbes: 0, animals: 0,
    plants: 0, city: 0,
};

const INITIAL_FIELD: FieldContents = [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null];

const INITIAL_MILESTONES: MilestonesData = {};

class GameService extends LongPollService<GameDoc, GameEvent> {
    async create(creator: WithId<UserDoc>, lobbyId: ObjectId): Promise<ObjectId> {
        const lobby = await lobbyService.get(lobbyId);
        if (!lobby.owner.equals(creator._id)) throw new AccessError("no owner access to lobby");

        const deck = Object.keys(PROJECT_STATIC).map(n => parseInt(n));
        shuffleArray(deck);
        const corpDeck = Object.keys(CORP_STATIC).map(n => parseInt(n));
        shuffleArray(corpDeck);

        const result = await games.insertOne({
            players: lobby.members.map((m, i) => ({
                idx: i,
                user: m,
                tr: 20,
                trGain: 0,
                labels: structuredClone(INITIAL_LABELS),
                pass: false,
                offer: deck.splice(deck.length - 10, 10),
                corpOffer: corpDeck.splice(corpDeck.length - 2, 2),
                hand: [],
                board: [],
                played: [],
                firstAction: true,
            })),
            events: [],
            messages: [],

            deck,
            discard: [],
            
            gen: 1,
            phase: "research",
            firstPlayer: 0,

            oxygen: 0,
            temperature: -30,
            field: structuredClone(INITIAL_FIELD),
            milestones: structuredClone(INITIAL_MILESTONES),
            awards: [],
            awardPrice: 8,
        });

        await userService.setStatusForMany(lobby.members, { activity: "game", gameId: result.insertedId });
        await lobbyService.publishEvent(lobby._id, { type: "game_started", data: { gameId: result.insertedId.toString() } });
        await lobbyService.delete(lobby._id);

        return result.insertedId;
    }

    async buy(buyer: WithId<UserDoc>, id: ObjectId, projects: number[], corp?: number) {
        let game = await this.get(id);
        if (!game.players.some(p => p.user.equals(buyer._id))) throw new AccessError("game doesn't include player");
        if (game.phase !== "research") throw new AccessError("phase doesn't match");
        if (game.gen > 1 && corp !== undefined || game.gen === 1 && corp === undefined) throw new ArgumentError("wrong parameters");

        const me = game.players.find(p => p.user.equals(buyer._id))!;
        if (!me.offer) throw new OverflowError("player already made purchase");

        if (game.gen === 1 && !me.corpOffer!.includes(corp!)) throw new ArgumentError("corp is not in offer");
        for (const project of projects) {
            if (!me.offer.includes(project)) throw new ArgumentError("project is not in offer");
        }
        
        const res = game.gen > 1 ? me.resources! : CORP_STATIC[corp!].res;
        if (projects.length * 3 > res.credits.count) throw new ResourceSufficiencyError("not enough megacredits");
        
        res.credits.count -= projects.length * 3;

        if (game.gen === 1 && corp !== undefined) {
            for (const label of CORP_STATIC[corp].labels) {
                me.labels[label] = (me.labels[label] ?? 0) + 1;
            }
        }

        await games.updateOne({ _id: id }, {
            $set: {
                ...(game.gen === 1 && {
                        [`players.${me.idx}.corporation`]: corp,
                        [`players.${me.idx}.labels`]: me.labels,
                }),
                [`players.${me.idx}.resources`]: res,
            },
            $addToSet: {
                [`players.${me.idx}.hand`]: { $each: projects },
                discard: { $each: me.offer.filter(p => !projects.includes(p)) },
            },
            $unset: {
                [`players.${me.idx}.offer`]: 1,
                [`players.${me.idx}.corpOffer`]: 1,
            }
        });

        game = await this.get(id);
        if (!game.players.some(p => p.offer)) {
            await this.switchToActionPhase(id, game.firstPlayer);
        }
    }

    async action(actor: WithId<UserDoc>, id: ObjectId, action: Action) {
        let game = await this.get(id);
        if (!game.players.some(p => p.user.equals(actor._id))) throw new AccessError("game doesn't include player");
        if (game.phase !== "action") throw new AccessError("phase doesn't match");
        
        const me = game.players.find(p => p.user.equals(actor._id))!;
        if (game.turn !== me.idx) throw new AccessError("turn doesn't match");

        const events: GameEvent[] = [];

        if (action.type === "standard_project") {
            this.#doStandardProject(action, game, me);
            events.push({
                type: "action",
                data: {
                    action: "standard_project",
                    player: me.idx,
                    standardProjectIdx: action.standardProjectIdx,
                }
            });
        } else if (action.type === "milestone") {
            this.#declareMilestone(action.milestoneName, game, me);
            events.push({
                type: "action",
                data: {
                    action: "milestone",
                    player: me.idx,
                    milestone: action.milestoneName,
                }
            });
        } else if (action.type === "award") {
            this.#establishAward(action.awardName, game, me);
            events.push({
                type: "action",
                data: {
                    action: "award",
                    player: me.idx,
                    award: action.awardName,
                }
            });
        } else if (action.type === "play_hand") {
            this.#playFromHand(action, game, me);
            events.push({
                type: "action",
                data: {
                    action: "hand_play",
                    player: me.idx,
                    project: action.project,
                }
            });
        } else if (action.type === "do_prject_action") {
            this.#doProjectAction(action, game, me);
            events.push({
                type: "action",
                data: {
                    action: "project_action",
                    player: me.idx,
                    project: action.project,
                }
            });
        } else if (action.type === "unmi") {
            this.#doUnmiAction(game, me);
            events.push({
                type: "action",
                data: { action: "unmi", player: me.idx }
            });
        } else if (action.type === "inventrix") {
            this.#doInventrixAction(game, me);
            events.push({
                type: "action",
                data: { action: "inventrix", player: me.idx },
            });
        } else if (action.type === "tharsis") {
            this.#doTharsisRepublicAction(game, me, action.pos);
            events.push({
                type: "action",
                data: { action: "tharsis", player: me.idx },
            });
        } else {
            throw new ArgumentError("action type incorrect");
        }

        if (game.actions === 2) {
            game.actions = 1;
        } else {
            let nextTurn = game.turn;
            while (true) {
                nextTurn += 1;
                if (!game.players[nextTurn % game.players.length].pass || nextTurn % game.players.length === game.turn)
                    break;
            }
            game.turn = nextTurn % game.players.length;
            game.actions = 2;

            events.push({
                type: "turn_changed",
                data: { turn: game.turn },
            });
        }

        delete me.firstAction;

        await games.replaceOne({ _id: id }, game);

        for (const event of events) {
            await this.publishEvent(id, event);
        }
    }

    async pass(actor: WithId<UserDoc>, id: ObjectId) {
        let game = await this.get(id);
        if (!game.players.some(p => p.user.equals(actor._id))) throw new AccessError("game doesn't include player");
        if (game.phase !== "action") throw new AccessError("phase doesn't match");

        const me = game.players.find(p => p.user.equals(actor._id))!;
        if (game.turn !== me.idx) throw new AccessError("turn doesn't match");
        if (game.actions! < 2) throw new AccessError("unable to pass after actions");

        me.pass = true;
        let nextTurn = game.turn;
        while (true) {
            nextTurn += 1;
            if (!game.players[nextTurn % game.players.length].pass || nextTurn % game.players.length === game.turn)
                break;
        }
        if (nextTurn % game.players.length !== game.turn) {
            await games.updateOne({ _id: id }, {
                $set: {
                    [`players.${me.idx}.pass`]: true,
                    turn: nextTurn % game.players.length,
                    actions: 2,
                }
            });
            await this.publishEvent(id, {
                type: "player_passed",
                data: { player: me.idx },
            });
            await this.publishEvent(id, {
                type: "turn_changed",
                data: { turn: nextTurn % game.players.length },
            });
        } else {
            await this.publishEvent(id, {
                type: "player_passed",
                data: { player: me.idx },
            });
            await this.switchToNextGeneration(game._id);
        }
    }

    async skip(actor: WithId<UserDoc>, id: ObjectId) {
        let game = await this.get(id);
        if (!game.players.some(p => p.user.equals(actor._id))) throw new AccessError("game doesn't include player");
        if (game.phase !== "action") throw new AccessError("phase doesn't match");

        const me = game.players.find(p => p.user.equals(actor._id))!;
        if (game.turn !== me.idx) throw new AccessError("turn doesn't match");
        if (game.actions! === 2) throw new AccessError("unable to skip before actions");

        let nextTurn = game.turn;
        while (true) {
            nextTurn += 1;
            if (!game.players[nextTurn % game.players.length].pass || nextTurn % game.players.length === game.turn)
                break;
        }

        await games.updateOne({ _id: id }, {
            $set: {
                turn: nextTurn % game.players.length,
                actions: 2,
            }
        });

        await this.publishEvent(id, {
            type: "player_skipped_action",
            data: { player: me.idx },
        });
        await this.publishEvent(id, {
            type: "turn_changed",
            data: { turn: nextTurn % game.players.length },
        });
    }

    async chat(author: WithId<UserDoc>, id: ObjectId, text: string) {
        const game = await this.get(id);
        const me = game.players.find(p => p.user.equals(author._id));
        if (!me) throw new AccessError("game doesn't include player");

        const message = { author: me.idx, text };

        games.updateOne({ _id: id }, {
            $push: {
                messages: message,
            }
        });

        await this.publishEvent(id, {
            type: "chat_message",
            data: message,
        });
    }

    async switchToActionPhase(id: ObjectId, firstPlayer: number) {
        const result = await games.updateOne({ _id: id }, {
            $set: {
                phase: "action",
                turn: firstPlayer,
                actions: 2,
            }
        });
        if (result.modifiedCount > 0) {
            await this.publishEvent(id, {
                type: "phase_changed",
                data: {
                    phase: "action",
                    turn: firstPlayer,
                }
            });
        }
    }

    async switchToNextGeneration(id: ObjectId) {
        const game = await this.get(id);
        for (const player of game.players) {
            player.resources!.heat.count += player.resources!.energy.count;
            player.resources!.credits.count += player.tr;
            for (const res of Object.values(player.resources!)) {
                res.count += res.production;
            }
        }

        const oceanTilesPlaced = game.field.filter(t => t !== null && t.type === "ocean").length;
        if (game.oxygen >= 14 && game.temperature >= 8 && oceanTilesPlaced >= 9) {
            await this.finishGame(game);
            return;
        }

        game.firstPlayer = (game.firstPlayer + 1) % game.players.length;
        game.gen += 1;
        game.phase = "research";
        // if (game.deck.length < game.players.length * 4) {
        //     shuffleArray(game.discard);
        //     game.deck.unshift(...game.discard);
        //     game.discard = [];
        // }
        for (const player of game.players) {
            player.trGain = 0;
            player.pass = false;
            // player.offer = game.deck.splice(game.deck.length - 4, 4);
            player.offer = this.#deckPop(game)(4);
            delete player.specialProject;
        }

        await games.replaceOne({ _id: game._id }, game);
        
        await this.publishEvent(game._id, {
            type: "generation_changed",
            data: {
                gen: game.gen,
            },
        });
    }

    async finishGame(game: WithId<GameDoc>) {
        await games.updateOne({ _id: game._id }, {
            $set: {
                phase: "finished",
            }
        });

        const playerIds = game.players.map(p => p.user);
        const users = await userService.getMany(playerIds);

        let results: GameResults = {
            players: [],
        }

        const awardWinners = this.#calculateAwardWinners(game);

        let vpSum = 0;
        let vpMax = 0;
        for (const player of game.players) {
            const vp = this.#calculatePlayerVP(game, awardWinners, player);
            results.players.push({ idx: player.idx, vp, eloGain: 0 });
            vpSum += vp;
            if (vp > vpMax) vpMax = vp;
        }
        const vpAvg = vpSum / game.players.length;

        let eloSum = 0;
        for (const user of users) {
            eloSum += user.stats.elo;
        }
        const eloAvg = eloSum / users.length;

        const tasks: Promise<void>[] = [];
        for (const playerResults of results.players) {
            const playerDetails = game.players[playerResults.idx];
            const user = users.find(u => u._id.equals(playerDetails.user))!;

            const k = 0.15;
            playerResults.eloGain = Math.max(0, ((playerResults.vp - vpAvg) * (eloAvg / vpAvg + 1) + eloAvg - user.stats.elo) * k);

            tasks.push(userService.applyGameResults(user._id, playerResults.eloGain, playerResults.vp === vpMax));
        }
        await Promise.all(tasks);
        await this.publishEvent(game._id, {
            type: "game_finished",
            data: results,
        });

        setTimeout(() => {
            this.delete(game._id);
        }, 60000);
    }

    async delete(id: ObjectId) {
        await games.deleteOne({ _id: id });
    }

    #calculatePlayerVP(game: GameDoc, awardWinners: AwardWinners, player: PlayerDetails): number {
        let vp = player.tr;

        for (const winners of Object.values(awardWinners)) {
            if (winners.top1.includes(player.idx)) vp += 5;
            if (game.players.length > 2 && winners.top1.length === 1 && winners.top2.includes(player.idx)) vp += 2;
        }

        if (Object.values(game.milestones).includes(player.idx)) vp += 5;

        for (let i = 0; i < game.field.length; ++i) {
            const tile = game.field[i];
            if (tile !== null) {
                if (tile.type === "greenery" && tile.owner === player.idx) vp += 1;
                if ((tile.type === "city" || tile.type === "capital") && tile.owner === player.idx) {
                    for (const nc of FIELD_CELL_STATIC[i].nc) {
                        const fcc = game.field[nc];
                        if (fcc !== null && fcc.type === "greenery") vp += 1;
                    }
                }
            }
        }

        for (const bc of player.board) {
            const ps = PROJECT_STATIC[bc.project];
            if (ps.vp) {
                vp += ps.vp({
                    field: game.field,
                    me: player,
                    cardResources: bc.res,
                });
            }
        }

        for (const project of player.played) {
            const ps = PROJECT_STATIC[project];
            if (ps.vp) {
                vp += ps.vp({
                    field: game.field,
                    me: player,
                });
            }
        }
        
        return vp;
    }

    #calculateAwardWinners(game: GameDoc): AwardWinners {
        const result: AwardWinners = {};
        for (const award of game.awards) {
            const players = new Array(game.players.length).fill(0);
            if (award === "landlord") {
                for (const tile of game.field) {
                    if (tile !== null && tile.type !== "ocean") players[tile.owner] += 1;
                }
            } else if (award === "banker") {
                for (const player of game.players) {
                    players[player.idx] = player.resources!.credits.production;
                }
            } else if (award === "scientist") {
                for (const player of game.players) {
                    players[player.idx] = player.labels.science;
                }
            } else if (award === "thermalist") {
                for (const player of game.players) {
                    players[player.idx] = player.resources!.heat.count;
                }
            } else if (award === "miner") {
                for (const player of game.players) {
                    players[player.idx] = player.resources!.steel.count + player.resources!.titanium.count;
                }
            } else continue;

            let top1Val = 0;
            let top2Val = 0;
            for (let i = 0; i < players.length; ++i) {
                if (players[i] > top1Val) {
                    top2Val = top1Val;
                    top1Val = players[i];
                }
            }
            const top1: number[] = [];
            const top2: number[] = [];
            for (let i = 0; i < players.length; ++i) {
                if (players[i] === top1Val) top1.push(i);
                if (players[i] === top2Val) top2.push(i);
            }
            result[award] = { top1, top2 };
        }
        return result;
    }

    #doStandardProject(action: StandardProjectAction, game: GameDoc, me: PlayerDetails) {
        if ((me.corporation === 1 || me.corporation === 4) && me.firstAction)
            throw new AccessError("your corporation obliges you to do special action as your first");
        if (action.standardProjectIdx === 0) {
            if (action.projects.length === 0) throw new ArgumentError("can't sell zero projects");
            for (const project of action.projects) {
                if (!me.hand.includes(project)) throw new ArgumentError("can't sell project you don't own");
            }
            removeFromArray(me.hand, action.projects);
            game.discard.push(...action.projects);
            me.resources!.credits.count += action.projects.length;
        } else if (action.standardProjectIdx === 1) {
            const cost = me.corporation! === 2 ? 8 : 11;
            if (me.resources!.credits.count < cost) throw new ResourceSufficiencyError("not enough megacredits");
            me.resources!.credits.count -= cost;
            me.resources!.energy.production += 1;
        } else if (action.standardProjectIdx === 2) {
            if (me.resources!.credits.count < 14) throw new ResourceSufficiencyError("not enough megacredits");
            me.resources!.credits.count -= 14;
            game.temperature += 1;
        } else if (action.standardProjectIdx === 3) {
            if (me.resources!.heat.count < 8) new ResourceSufficiencyError("not enough heat");
            me.resources!.heat.count -= 8;
            game.temperature += 1;
        } else if (action.standardProjectIdx === 4) {
            if (me.resources!.credits.count < 23) throw new ResourceSufficiencyError("not enough megacredits");
            if (action.pos < 0 || action.pos > 62) throw new OverflowError("incorrect tile position");
            if (!standardGreeneryPredicate(game.field, me)(action.pos)) throw new TilePositioningError("bad tile position");
            me.resources!.credits.count -= 23;
            this.#placeTile(game, me)(action.pos, {
                type: "greenery",
                owner: me.idx,
            });
        } else if (action.standardProjectIdx === 5) {
            const cost = me.corporation! === 6 ? 7 : 8;
            if (me.resources!.plants.count < cost) throw new ResourceSufficiencyError("not enough plants");
            if (action.pos < 0 || action.pos > 62) throw new OverflowError("incorrect tile position");
            if (!standardGreeneryPredicate(game.field, me)(action.pos)) throw new TilePositioningError("bad tile position");
            me.resources!.plants.count -= cost;
            this.#placeTile(game, me)(action.pos, {
                type: "greenery",
                owner: me.idx,
            });
        } else if (action.standardProjectIdx === 6) {
            if (me.resources!.credits.count < 18) throw new ResourceSufficiencyError("not enough megacredits");
            if(!standardOceanPredicate(game.field)(action.pos)) throw new TilePositioningError("bad tile position");
            me.resources!.credits.count -= 18;
            this.#placeTile(game, me)(action.pos, {
                type: "ocean",
            });
        } else if (action.standardProjectIdx === 7) {
            if (me.resources!.credits.count < 25) throw new ResourceSufficiencyError("not enough megacredits");
            if (!standardCityPredicate(game.field)(action.pos)) throw new TilePositioningError("bad tile position");
            me.resources!.credits.count -= 18;
            this.#placeTile(game, me)(action.pos, {
                type: "city",
                owner: me.idx
            });
        } else {
            throw new ArgumentError("standard project index incorrect");
        }
    }

    #declareMilestone(milestone: MilestoneName, game: GameDoc, me: PlayerDetails) {
        if ((me.corporation === 1 || me.corporation === 4) && me.firstAction)
            throw new AccessError("your corporation obliges you to do special action as your first");
        if (Object.values(game.milestones).length >= 3) throw new ArgumentError("milestone can't be declared");
        if (me.resources!.credits.count < 8) throw new ResourceSufficiencyError("not enough megacredits");
        if (!["terraformer", "mayor", "gardener", "builder", "planner"].includes(milestone)) throw new ArgumentError("milestone name incorrect");
        if (game.milestones[milestone]) throw new OverflowError("milestone already declared");
        if (milestone === "terraformer") {
            if (me.tr < 32) throw new ActionRequirementsError("not enough TR for this milestone");
            game.milestones.terraformer = me.idx;
        } else if (milestone === "mayor") {
            if (game.field.filter(t => t !== null && (t.type === "city" || t.type === "capital") && t.owner === me.idx).length < 3)
                throw new ActionRequirementsError("not enough city tiles");
            game.milestones.mayor = me.idx;
        } else if (milestone === "gardener") {
            if (game.field.filter(t => t !== null && t.type === "greenery" && t.owner === me.idx).length < 3)
                throw new ActionRequirementsError("not enough greenery tiles");
            game.milestones.gardener = me.idx; 
        } else if (milestone === "builder") {
            if (me.labels.building < 8) throw new ActionRequirementsError("not enough building labels");
            game.milestones.builder = me.idx;
        } else if (milestone === "planner") {
            if (me.hand.length < 16) throw new ActionRequirementsError("not enough project cards in hand");
            game.milestones.planner = me.idx;
        }
        me.resources!.credits.count -= 8;
    }

    #establishAward(award: AwardName, game: GameDoc, me: PlayerDetails) {
        if ((me.corporation === 1 || me.corporation === 4) && me.firstAction)
            throw new AccessError("your corporation obliges you to do special action as your first");
        if (game.awardPrice === undefined) throw new ArgumentError("award can't be established");
        if (me.resources!.credits.count < game.awardPrice) throw new ResourceSufficiencyError("not enough megacredits");
        if (!["landlord", "banker", "scientist", "thermalist", "miner"].includes(award)) throw new ArgumentError("award name incorrect");
        if (game.awards.includes(award)) throw new OverflowError("award is already established");
        game.awards.push(award);
        me.resources!.credits.count -= game.awardPrice;

        if (game.awardPrice === 8) game.awardPrice = 14;
        else if (game.awardPrice === 14) game.awardPrice = 20;
        else if (game.awardPrice === 20) game.awardPrice = undefined;
    }

    #playFromHand(action: PlayHandAction, game: GameDoc, me: PlayerDetails) {
        if ((me.corporation === 1 || me.corporation === 4) && me.firstAction)
            throw new AccessError("your corporation obliges you to do special action as your first");
        if (!me.hand.includes(action.project)) throw new ArgumentError("can't play project you don't own");
        
        const ps = PROJECT_STATIC[action.project];

        let cost = ps.cost;
        let requirements = ps.globalRequirements ?? {};

        // modify cost and requirements

        const corpStatic = CORP_STATIC[me.corporation!];
        if (corpStatic.effects?.modifyProjectCost) {
            cost = corpStatic.effects.modifyProjectCost(cost, ps);
        }
        if (corpStatic.effects?.modifyGlobalRequirements) {
            requirements = corpStatic.effects.modifyGlobalRequirements(requirements);
        }

        for (const { project } of me.board) {
            const otherPS = PROJECT_STATIC[project];
            if (otherPS.type === "active" && otherPS.subtype === "effect") {
                if (otherPS.effects.modifyProjectCost) {
                    cost = otherPS.effects.modifyProjectCost(cost, ps);
                }
                if (otherPS.effects.modifyGlobalRequirements) {
                    requirements = otherPS.effects.modifyGlobalRequirements(requirements);
                }
            }
        }

        if (me.specialProject) {
            for (const requirement of Object.values(requirements)) {
                if (requirement.type === "min") requirement.amount -= 2;
                else requirement.amount += 2;
            }
        }

        // check fee
        this.#validateFee(game, me.idx, cost, action.fee, ps.labels, me.corporation === 8);

        // check global requirements
        const oceanTilesPlaced = game.field.filter(c => c !== null && c.type === "ocean").length;
        let satisfied = true;
        for (const [p, req] of Object.entries(requirements)) {
            if (p === "temperature") {
                if (
                    req.type === "min" && game.temperature < req.amount ||
                    req.type === "max" && game.temperature > req.amount
                ) {
                    satisfied = false;
                    break;
                }
            } else if (p === "oxygen") {
                if (
                    req.type === "min" && game.oxygen < req.amount ||
                    req.type === "max" && game.oxygen > req.amount
                ) {
                    satisfied = false;
                    break;
                }
            } else if (p === "ocean") {
                if (
                    req.type === "min" && oceanTilesPlaced < req.amount ||
                    req.type === "max" && oceanTilesPlaced > req.amount
                ) {
                    satisfied = false;
                    break;
                }
            }
        }
        if (!satisfied) throw new ActionRequirementsError("global requirements are not satisfied");

        // check secondary requirements
        let canPlay = true;
        if (ps.canPlay && !ps.canPlay({ me: me.idx, players: game.players, field: game.field })) canPlay = false;
        if (!canPlay) throw new ActionRequirementsError("secondary requirements are not satisfied");

        // remove special project effect
        delete me.specialProject;

        // add labels
        if (ps.type !== "event" && ps.labels) {
            for (const label of ps.labels) {
                me.labels[label] += 1;
            }
        }

        // finally play card
        if (ps.playServer) {
            ps.playServer({
                doc: game,
                me: me.idx,
                placeTile: this.#placeTile(game, me),
                increaseGlobal: this.#increaseGlobal(game, me),
                gainTR: this.#gainTR(me),
                validateFee: this.#validateFee,
                deckPop: this.#deckPop(game),
            }, action.data);
        }

        // add to board if active
        if (ps.type === "active") {
            me.board.push({
                project: action.project,
                gen: 0,
                res: ps.initialResources ?? {}
            });
        } else {
            me.played.push(action.project);
        }

        // romove from hand
        me.hand.splice(me.hand.findIndex(p => p === action.project), 1);

        // decrease resources
        for (const [name, val] of Object.entries(action.fee) as [ResourceName, number][]) {
            me.resources![name].count -= val;
        }

        // call onPlayProjectCard effects
        for (const player of game.players) {
            const cs = CORP_STATIC[player.corporation!];
            if (cs.effects && cs.effects.onPlayProjectCard) {
                cs.effects.onPlayProjectCard({
                    doc: game,
                    me: player.idx,
                    player: me.idx,
                    project: action.project,
                });
            }
            for (const boardCard of player.board) {
                const ps = PROJECT_STATIC[boardCard.project];
                if (ps.type === "active" && ps.subtype === "effect" && ps.effects.onPlayProjectCard) {
                    ps.effects.onPlayProjectCard({
                        doc: game,
                        me: player.idx,
                        player: me.idx,
                        project: action.project,
                        thisCard: boardCard,
                    });
                }
            }
        }
    }

    #doProjectAction(action: DoProjectAction, game: GameDoc, me: PlayerDetails) {
        if ((me.corporation === 1 || me.corporation === 4) && me.firstAction)
            throw new AccessError("your corporation obliges you to do special action as your first");
        const bc = me.board.find(bc => bc.project === action.project);
        if (!bc) throw new ArgumentError("can't do action of project you don't have on board");
        const ps = PROJECT_STATIC[action.project];
        if (ps.type !== "active" || ps.subtype !== "action") throw new ArgumentError("can't do action of not action project");
        if (ps.canDoAction && !ps.canDoAction({ me: me.idx, players: game.players, field: game.field })) throw new ActionRequirementsError("project action requirements are not satisfied");
        if (bc.gen >= game.gen) throw new ArgumentError("action already done this generation");

        if (ps.doActionServer) {
            ps.doActionServer({
                doc: game,
                me: me.idx,
                placeTile: this.#placeTile(game, me),
                increaseGlobal: this.#increaseGlobal(game, me),
                gainTR: this.#gainTR(me),
                validateFee: this.#validateFee,
                deckPop: this.#deckPop(game),
            }, action.data);
        }

        // set action done this generation
        bc.gen = game.gen;
    }

    #doUnmiAction(game: GameDoc, me: PlayerDetails) {
        if (me.corporation !== 7) throw new AccessError("unmi action available for unmi player only");
        if (me.unmiGen! >= game.gen) throw new ArgumentError("action already done this generation");
        if (me.trGain <= 0) throw new ActionRequirementsError("unmi action requirement is not satisfied");
        if (me.resources!.credits.count < 3) throw new ResourceSufficiencyError("not enough megacredits");

        me.resources!.credits.count -= 3;
        this.#gainTR(me)(1);
        
        me.unmiGen = game.gen;
    }

    #doInventrixAction(game: GameDoc, me: PlayerDetails) {
        if (me.corporation !== 1 || !me.firstAction) throw new AccessError("inventrix action available for inventrix player only as his 1st action");
        
        me.hand.push(...this.#deckPop(game)(3));
    }

    #doTharsisRepublicAction(game: GameDoc, me: PlayerDetails, pos: number) {
        if (me.corporation !== 4 || !me.firstAction) throw new AccessError("tharsis republic action available for tharsis republic player only as his 1st action");
        if (!standardCityPredicate(game.field)(pos)) throw new TilePositioningError("bad tile position");

        this.#placeTile(game, me)(pos, { type: "city", owner: me.idx });
    }

    #validateFee(game: GameDoc, me: number, price: number, fee: Partial<Record<ResourceName, number> >, labels?: LabelName[], heatAllowed?: boolean) {
        if (Object.keys(fee).includes("plants") || Object.keys(fee).includes("energy")) throw new ResourceRelevanceError("you can't pay with these resources");
        if (!(labels ?? []).includes("building") && Object.keys(fee).includes("steel")) throw new ResourceRelevanceError("you can't pay with these resources");
        if (!(labels ?? []).includes("space") && Object.keys(fee).includes("titanium")) throw new ResourceRelevanceError("you can't pay with these resources");
        if (!heatAllowed && Object.keys(fee).includes("heat")) throw new ResourceRelevanceError("you can't pay with these resources");

        let feeSum = 0;
        for (const [res, amount] of Object.entries(fee) as [ResourceName, number][]) {
            if (game.players[me].resources![res].count < amount) throw new ResourceSufficiencyError("not enough resources");
            if (res === "credits") feeSum += amount;
            if (res === "steel" && (labels ?? []).includes("building")) feeSum += amount * 2;
            if (res === "titanium" && (labels ?? []).includes("space")) feeSum += amount * (game.players[me].corporation === 3 ? 4 : 3);
            if (res === "heat" && heatAllowed) feeSum += amount;
        }
        if (feeSum < price) throw new FeeError("your fee is not enough");
        for (const [res, amount] of Object.entries(fee) as [ResourceName, number][]) {
            if (amount > 0) {
                if ((res === "credits" || res === "heat" ) && feeSum - 1 >= price) throw new FeeError("overpayment");
                if (res === "steel" && feeSum - 2 >= price) throw new FeeError("overpayment");
                if (res === "titanium" && feeSum - (game.players[me].corporation === 3 ? 4 : 3) >= price) throw new FeeError("overpayment");
            }
        }
    }

    #placeTile(game: GameDoc, me: PlayerDetails) {
        return (pos: number, tile: Tile) => {
            if (tile.type === "ocean") {
                const oceanTilesPlaced = game.field.filter(t => t !== null && t.type === "ocean").length;
                if (oceanTilesPlaced >= 9) return;
            }
            game.field[pos] = tile;
            if (tile.type === "ocean") this.#gainTR(me)(1);
            if (tile.type === "greenery") this.#increaseGlobal(game, me)("oxygen", 1);

            // gain resources
            const fcs = FIELD_CELL_STATIC[pos];
            if (fcs.reward) {
                for (const reward of fcs.reward) {
                    if (reward.res === "project") {
                        const projects = this.#deckPop(game)(reward.amount);
                        me.hand.push(...projects);
                    } else {
                        me.resources![reward.res].count += reward.amount;
                    }
                }
            }

            // call onPlaceTile effects
            for (const player of game.players) {
                const cs = CORP_STATIC[player.corporation!];
                if (cs.effects && cs.effects.onPlaceTile) {
                    cs.effects.onPlaceTile({
                        doc: game,
                        me: player.idx,
                        tile,
                        zoneIdx: pos,
                    });
                }
                for (const boardCard of player.board) {
                    const ps = PROJECT_STATIC[boardCard.project];
                    if (ps.type === "active" && ps.subtype === "effect" && ps.effects.onPlaceTile) {
                        ps.effects.onPlaceTile({
                            doc: game,
                            me: player.idx,
                            tile,
                            zoneIdx: pos,
                            thisCard: boardCard,
                        });
                    }
                }
            }
        }
    }

    #increaseGlobal(game: GameDoc, me: PlayerDetails) {
        return (parameter: "oxygen" | "temperature", amount: number) => {
            if (parameter === "oxygen" && game.oxygen >= 14) return;
            if (parameter === "temperature" && game.temperature >= 8) return;
            game[parameter] += amount;
            this.#gainTR(me)(amount);
        }
    }

    #gainTR(me: PlayerDetails) {
        return (amount: number) => {
            me.tr += amount;
            me.trGain += amount;
        }
    }

    #deckPop(game: GameDoc) {
        return (count: number = 1) => {
            if (game.deck.length < count) {
                shuffleArray(game.discard);
                game.deck.unshift(...game.discard);
                game.discard = [];
            }
            return game.deck.splice(game.deck.length - count, count);
        }
    }

    async getGameState(player: WithId<UserDoc>, id: ObjectId): Promise<GameStateDTO> {

        type AggregatedGameDoc = WithId<GameDoc> & { __lookup: WithId<UserDoc>[] };

        const gamesCur = games.aggregate<AggregatedGameDoc>([
            { $match: { _id: id } },
            { $lookup: {
                from: "users",
                localField: "players.user",
                foreignField: "_id",
                as: "__lookup"
            } }
        ]);
        const game = await gamesCur.next();
        if (!game) throw new EntityExistanceError("no such game");
        const me = game.players.find(p => p.user.equals(player._id));
        if (!me) throw new AccessError("game doesn't include player");

        return {
            id: game._id.toString(),
            players: game.players.map(p => ({
                idx: p.idx,
                user: mapUserDetails(game.__lookup.find(u => u._id.equals(p.user))!),
                tr: p.tr,
                trGain: p.trGain,
                corporation: p.corporation,
                resources: p.resources,
                labels: p.labels,
                pass: p.pass,
                ...(p.offer && { offer: p.offer }),
                ...(p.corpOffer && { corpOffer: p.corpOffer }),
                ...(p.user.equals(player._id) && { hand: p.hand }),
                board: p.board,
                ...(p.unmiGen !== undefined && p.unmiGen !== null && { unmiGen: p.unmiGen }),
                ...(p.specialProject !== undefined && { specialProject: p.specialProject }),
                ...(p.firstAction !== undefined && { firstAction: p.firstAction }),
            })),

            ei: game.events.length,
            messages: game.messages,

            gen: game.gen,
            phase: game.phase,
            ...(game.turn !== undefined && game.turn !== null && { turn: game.turn }),
            ...(game.phase === "action" && game.turn === me.idx && { canPass: game.actions! >= 2 }),

            oxygen: game.oxygen,
            temperature: game.temperature,
            field: game.field,

            milestones: game.milestones,
            awards: game.awards,
            ...(game.awardPrice !== undefined && game.awardPrice !== null && { awardPrice: game.awardPrice })
        };
    }

    async get(id: ObjectId): Promise<WithId<GameDoc>> {
        const game = await games.findOne({ _id: id });
        if (!game) throw new EntityExistanceError("no such game");
        return game;
    }

    async addEvent(id: ObjectId, event: GameEvent): Promise<void> {
        await games.updateOne({ _id: id }, {
            $push: { events: event }
        });
    }

    extractEvents(doc: WithId<GameDoc>): GameEvent[] {
        return doc.events;
    }

    checkEventRequestRights(requestor: WithId<UserDoc>, doc: WithId<GameDoc>): void {
        if (!doc.players.some(p => p.user.equals(requestor._id))) {
            throw new AccessError("game doesn't include player");
        }
    }

}

export const gameService = new GameService();
