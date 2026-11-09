/**
 * Finds the functions in a JavaScript or TypeScript file with their line ranges, cyclomatic
 * complexity and a hash of their body (to recognise a function that only moved).
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';

export type FunctionInfo = {
	/** Qualified name: `outer/inner`, `Class.method`, `object.property`, or `<anonymous>`. */
	name: string;
	startLine: number;
	endLine: number;
	complexity: number;
	/** Lines of nested functions, which count for those functions, not this one. */
	nestedRanges: Array<[number, number]>;
	bodyHash: string;
};

const DECISION_KINDS = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ConditionalExpression,
	ts.SyntaxKind.CaseClause,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
	ts.SyntaxKind.CatchClause
]);

const LOGICAL_OPERATORS = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken
]);

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
	ts.isFunctionLike(node) && 'body' in node && Boolean((node as ts.FunctionLikeDeclaration).body);

/** 1 + every branch: if, ?:, case, loops, catch, &&, ||, ??. Nested functions are not counted. */
export function cyclomaticComplexity(fn: ts.Node): number {
	let count = 1;
	const visit = (node: ts.Node) => {
		if (node !== fn && (isFunction(node) || ts.isClassLike(node))) return;
		if (DECISION_KINDS.has(node.kind)) count++;
		if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) count++;
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(fn, visit);
	return count;
}

function ownName(node: ts.Node): string | undefined {
	const named = node as { name?: ts.Node };
	if (named.name && (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name) || ts.isStringLiteral(named.name))) {
		return named.name.text;
	}
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
	if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
		return parent.name.text;
	}
	if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
	if (ts.isExportAssignment(parent)) return 'default';
	const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return 'default';
	return undefined;
}

/**
 * The name an object literal is bound to: `const api = { ... }`, or through a wrapper call such as
 * `export const save = mutation({ handler() {} })`.
 */
function objectHolderName(object: ts.ObjectLiteralExpression): string | undefined {
	const holder = ts.isCallExpression(object.parent) ? object.parent.parent : object.parent;
	return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : undefined;
}

/** The names of the containers between the file and `node`: classes, objects bound to a name, functions. */
function containerPrefix(node: ts.Node): string[] {
	const parts: string[] = [];
	for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
		if (ts.isClassLike(parent) && parent.name) parts.unshift(parent.name.text);
		else if (isFunction(parent)) parts.unshift(ownName(parent) ?? '<anonymous>');
		else if (ts.isObjectLiteralExpression(parent)) {
			const holder = objectHolderName(parent);
			if (holder) parts.unshift(holder);
		}
	}
	return parts;
}

const isMember = (node: ts.Node) =>
	ts.isMethodDeclaration(node) ||
	ts.isGetAccessor(node) ||
	ts.isSetAccessor(node) ||
	ts.isConstructorDeclaration(node) ||
	ts.isPropertyAssignment(node.parent) ||
	ts.isPropertyDeclaration(node.parent);

/** `outer/inner` for nested functions, `Class.method` and `object.property` for members. */
function qualifiedName(node: ts.Node): string {
	const own = ts.isConstructorDeclaration(node) ? 'constructor' : (ownName(node) ?? '<anonymous>');
	const prefix = containerPrefix(node);
	if (prefix.length === 0) return own;
	return `${prefix.join('/')}${isMember(node) ? '.' : '/'}${own}`;
}

const lineOf = (source: ts.SourceFile, position: number) => source.getLineAndCharacterOfPosition(position).line + 1;

function bodyHash(source: ts.SourceFile, fn: ts.FunctionLikeDeclaration): string {
	const text = (fn.body ?? fn).getText(source).replace(/\s+/g, ' ').trim();
	return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function scriptKindFor(fileName: string): ts.ScriptKind {
	if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/** Every function with a body in `text`, outer before inner. */
export function findFunctions(fileName: string, text: string): FunctionInfo[] {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
	const found: Array<FunctionInfo & { node: ts.Node }> = [];
	const visit = (node: ts.Node) => {
		if (isFunction(node)) {
			found.push({
				node,
				name: qualifiedName(node),
				startLine: lineOf(source, node.getStart(source)),
				endLine: lineOf(source, node.getEnd()),
				complexity: cyclomaticComplexity(node),
				nestedRanges: [],
				bodyHash: bodyHash(source, node)
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	for (const outer of found) {
		outer.nestedRanges = found
			.filter((inner) => inner !== outer && isDirectlyNested(inner.node, outer.node))
			.map((inner) => [inner.startLine, inner.endLine] as [number, number]);
	}
	return found.map(({ node: _node, ...info }) => info);
}

function isDirectlyNested(inner: ts.Node, outer: ts.Node): boolean {
	for (let parent = inner.parent; parent; parent = parent.parent) {
		if (parent === outer) return true;
		if (isFunction(parent)) return false;
	}
	return false;
}
