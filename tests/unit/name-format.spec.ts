import { describe, expect, it } from 'vitest';
import { formatPersonName, buildPersonName, formatFirmName, formatEntityName } from '@/lib/nameFormat';

describe('nameFormat', () => {
	describe('formatPersonName', () => {
		it('formats all-caps individual names to Capital Case', () => {
			expect(formatPersonName('MICHAEL CHOI')).toBe('Michael Choi');
			expect(formatPersonName('JOHN DAVID DOE')).toBe('John David Doe');
		});

		it('formats LAST, FIRST MIDDLE to First Middle Last in Capital Case', () => {
			expect(formatPersonName('CHOI, MICHAEL')).toBe('Michael Choi');
			expect(formatPersonName('DOE, JOHN DAVID')).toBe('John David Doe');
			expect(formatPersonName('SMITH, JANE M, JR')).toBe('Jane M Smith Jr.');
		});

		it('formats names from objects with firstName, middleName, lastName, suffix', () => {
			expect(
				formatPersonName({
					firstName: 'MICHAEL',
					middleName: 'D',
					lastName: 'CHOI',
				}),
			).toBe('Michael D Choi');

			expect(
				formatPersonName({
					firstName: 'john',
					middleName: 'david',
					lastName: 'smith',
					suffix: 'jr',
				}),
			).toBe('John David Smith Jr.');
		});

		it('handles hyphens, apostrophes and initials properly', () => {
			expect(formatPersonName("O'CONNOR, LIAM")).toBe("Liam O'Connor");
			expect(formatPersonName('ANNA-MARIE SMITH-JONES')).toBe('Anna-Marie Smith-Jones');
			expect(formatPersonName('ROBERT J. SMITH')).toBe('Robert J. Smith');
		});
	});

	describe('buildPersonName', () => {
		it('combines first middle last into Capital Case', () => {
			expect(buildPersonName('JOHN', 'MICHAEL', 'DOE')).toBe('John Michael Doe');
			expect(buildPersonName('jane', '', 'doe')).toBe('Jane Doe');
			expect(buildPersonName('william', 't', 'riker', 'jr')).toBe('William T Riker Jr.');
		});
	});

	describe('formatFirmName', () => {
		it('formats 3-letter firm names to ALL CAPS', () => {
			expect(formatFirmName('ubs')).toBe('UBS');
			expect(formatFirmName('pnc')).toBe('PNC');
			expect(formatFirmName('ria')).toBe('RIA');
			expect(formatFirmName('kgi')).toBe('KGI');
			expect(formatFirmName('abc')).toBe('ABC');
			expect(formatFirmName('amp')).toBe('AMP');
		});

		it('formats multi-word firm names with Capital Case and 2-3 letter acronyms in ALL CAPS', () => {
			expect(formatFirmName('J.P. MORGAN SECURITIES LLC')).toBe('J.P. Morgan Securities LLC');
			expect(formatFirmName('GOLDMAN SACHS & CO. LLC')).toBe('Goldman Sachs & Co. LLC');
			expect(formatFirmName('BLACKROCK FINANCIAL MANAGEMENT, INC.')).toBe('Blackrock Financial Management, Inc.');
			expect(formatFirmName('CITI PRIVATE ADVISORY LLC')).toBe('Citi Private Advisory LLC');
			expect(formatFirmName('VANGUARD MARKETING CORPORATION')).toBe('Vanguard Marketing Corporation');
		});
	});

	describe('formatEntityName', () => {
		it('routes to formatPersonName or formatFirmName correctly', () => {
			expect(formatEntityName('MICHAEL CHOI', 'individual')).toBe('Michael Choi');
			expect(formatEntityName('ubs', 'firm')).toBe('UBS');
			expect(formatEntityName('J.P. MORGAN SECURITIES LLC', 'firm')).toBe('J.P. Morgan Securities LLC');
		});
	});
});
