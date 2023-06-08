export function shuffleArray(arr: any[]) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export function removeFromArray(arr: any[], things: any[]) {
    let i = 0;
    while (i < arr.length) {
        if (things.includes(arr[i])) {
            arr.splice(i, 1);
        } else {
            ++i;
        }
    }
}
