import { WithId } from "mongodb";
import { UserDetailsDTO, UserStatusDTO } from "tfm_common/lib/dto/user.js";
import { UserDoc, UserStatus } from "../types/user.js";

export function mapUserDetails(user: WithId<UserDoc>): UserDetailsDTO {
    return {
        id: user._id.toString(),
        username: user.username,
        hasAvatar: !!user.avatar,
        registrationTime: user.registrationTime.toISOString(),
        personal: user.personal,
        stats: user.stats,
        status: mapStatus(user.status),
    };
}

function mapStatus(status: UserStatus): UserStatusDTO {
    if (!status) return undefined;
    if (status.activity === "lobby") return {
        activity: "lobby",
        lobbyId: status.lobbyId.toString(),
    };
    else return {
        activity: "game",
        gameId: status.gameId.toString(),
    };
}
