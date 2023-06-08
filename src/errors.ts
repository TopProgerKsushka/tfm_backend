export class EntityExistanceError extends Error {
    constructor(messasge?: string) {
        super(messasge);
        this.name = "EntityExistanceError";
    }
}

export class ArgumentError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "ArgumentError";
    }
}

export class AccessError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "AccessError";
    }
}

export class OverflowError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "OverflowError";
    }
}

export class ResourceSufficiencyError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "ResourceSufficiencyError";
    }
}

export class ResourceRelevanceError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "ResourceRelevanceError";
    }
}

export class TilePositioningError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "ResourceSufficiencyError";
    }
}

export class ActionRequirementsError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "ProjectRequirementsError";
    }
}

export class FeeError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "FeeError";
    }
}
