// Parses Kubernetes resource quantity strings (the same format used in
// ActionTemplateEntity-derived container requests, e.g. "100m", "2Gi",
// "10Gi") into plain numbers the dispatcher's capacity arithmetic can add
// and compare without re-parsing on every cycle.

const BINARY_UNITS: Record<string, number> = {
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    Pi: 2 ** 50,
    Ei: 2 ** 60,
};

const DECIMAL_UNITS: Record<string, number> = {
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
};

/** CPU quantities are either a bare core count ("2", "0.5") or millicores ("500m") */
export function parseCpuMilli(quantity: string | undefined): number {
    if (!quantity) return 0;
    const trimmed = quantity.trim();
    if (trimmed.endsWith('m')) {
        const value = Number.parseFloat(trimmed.slice(0, -1));
        return Number.isNaN(value) ? 0 : Math.round(value);
    }
    const value = Number.parseFloat(trimmed);
    return Number.isNaN(value) ? 0 : Math.round(value * 1000);
}

/** Memory/ephemeral-storage quantities, e.g. "10Gi", "500M", "1024" (bytes) */
export function parseBytes(quantity: string | undefined): number {
    if (!quantity) return 0;
    const trimmed = quantity.trim();
    const match = /^([0-9.eE+-]+)([A-Za-z]*)$/.exec(trimmed);
    if (!match) return 0;
    const [, numberPart, unit] = match;
    const value = Number.parseFloat(numberPart);
    if (Number.isNaN(value)) return 0;
    if (!unit) return Math.round(value);
    const multiplier = BINARY_UNITS[unit] ?? DECIMAL_UNITS[unit];
    return multiplier ? Math.round(value * multiplier) : Math.round(value);
}

/** nvidia.com/gpu (and similar device-plugin resources) are always whole-number quantities */
export function parseGpuCount(quantity: string | undefined): number {
    if (!quantity) return 0;
    const value = Number.parseFloat(quantity.trim());
    return Number.isNaN(value) ? 0 : Math.round(value);
}
