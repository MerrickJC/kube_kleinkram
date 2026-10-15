import { parseBytes, parseCpuMilli, parseGpuCount } from '../../src/actions/helper/pod-requests';

describe('Pod Request Quantity Parsing', () => {
    test('should parse a millicpu suffix directly', () => {
        expect(parseCpuMilli('500m')).toBe(500);
    });

    test('should parse a bare core count as whole cores times 1000', () => {
        expect(parseCpuMilli('2')).toBe(2000);
        expect(parseCpuMilli('0.5')).toBe(500);
    });

    test('should return 0 for an undefined cpu quantity', () => {
        expect(parseCpuMilli(undefined)).toBe(0);
    });

    test('should parse binary (Gi/Mi/Ki) memory suffixes', () => {
        expect(parseBytes('1Gi')).toBe(2 ** 30);
        expect(parseBytes('10Gi')).toBe(10 * 2 ** 30);
        expect(parseBytes('512Mi')).toBe(512 * 2 ** 20);
    });

    test('should parse decimal (G/M/K) memory suffixes', () => {
        expect(parseBytes('1G')).toBe(1e9);
    });

    test('should parse a bare byte count with no suffix', () => {
        expect(parseBytes('1024')).toBe(1024);
    });

    test('should return 0 for an unparseable memory quantity', () => {
        expect(parseBytes('not-a-quantity')).toBe(0);
    });

    test('should round a fractional gpu quantity to the nearest whole device', () => {
        expect(parseGpuCount('1')).toBe(1);
        expect(parseGpuCount(undefined)).toBe(0);
    });
});
