/**
 * Finds the functions in a JavaScript or TypeScript file with their line ranges, cyclomatic
 * complexity and a hash of their body (to recognise a function that only moved).
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
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
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken
]);
const isFunction = (node) => ts.isFunctionLike(node) && 'body' in node && Boolean(node.body);
/** 1 + every branch: if, ?:, case, loops, catch, &&, ||, ??. Nested functions are not counted. */
export function cyclomaticComplexity(fn) {
    let count = 1;
    const visit = (node) => {
        if (node !== fn && (isFunction(node) || ts.isClassLike(node)))
            return;
        if (DECISION_KINDS.has(node.kind))
            count++;
        if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind))
            count++;
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return count;
}
const printer = ts.createPrinter({ removeComments: true });
/** Code of a node for a name: without comments, on one line, at most `max` characters. */
const shorten = (node, max) => {
    const code = printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
    const flat = code.replace(/\s+/g, ' ').replace(/ ?([.(]) /g, '$1').replace(/ \./g, '.').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/**
 * A function passed to a call is named after the call and its other arguments, which usually tell
 * calls of the same function apart: `app.get('/orders', <callback>)`, `useEffect(<callback>, [id])`.
 */
function callbackName(node) {
    const call = node.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === node))
        return undefined;
    const args = call.arguments.map((argument) => argument === node ? '<callback>' : isFunction(argument) ? '<fn>' : shorten(argument, 32));
    return `${shorten(call.expression, 40)}(${args.join(', ')})`;
}
const ASSIGNMENTS = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken
]);
/** A function assigned to something is named after it: `script.onerror = () => …`. */
function assignedName(node) {
    const assignment = node.parent;
    if (!ts.isBinaryExpression(assignment) || assignment.right !== node || !ASSIGNMENTS.has(assignment.operatorToken.kind)) {
        return undefined;
    }
    return shorten(assignment.left, 40);
}
function ownName(node) {
    const named = node;
    if (named.name && (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name) || ts.isStringLiteral(named.name))) {
        return named.name.text;
    }
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
        return parent.name.text;
    if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
        return parent.name.text;
    }
    if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name))
        return parent.name.text;
    if (ts.isExportAssignment(parent))
        return 'default';
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
        return 'default';
    return callbackName(node) ?? assignedName(node);
}
/**
 * The name an object literal is bound to: `const api = { ... }`, or through a wrapper call such as
 * `export const save = mutation({ handler() {} })`.
 */
function objectHolderName(object) {
    const holder = ts.isCallExpression(object.parent) ? object.parent.parent : object.parent;
    return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : undefined;
}
/** The names of the containers between the file and `node`: classes, objects bound to a name, functions. */
function containerPrefix(node) {
    const parts = [];
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if (ts.isClassLike(parent) && parent.name)
            parts.unshift(parent.name.text);
        else if (isFunction(parent))
            parts.unshift(ownName(parent) ?? '<anonymous>');
        else if (ts.isObjectLiteralExpression(parent)) {
            const holder = objectHolderName(parent);
            if (holder)
                parts.unshift(holder);
        }
    }
    return parts;
}
const isMember = (node) => ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isPropertyAssignment(node.parent) ||
    ts.isPropertyDeclaration(node.parent);
/** `outer/inner` for nested functions, `Class.method` and `object.property` for members. */
function qualifiedName(node) {
    const own = ts.isConstructorDeclaration(node) ? 'constructor' : (ownName(node) ?? '<anonymous>');
    const prefix = containerPrefix(node);
    if (prefix.length === 0)
        return own;
    return `${prefix.join('/')}${isMember(node) ? '.' : '/'}${own}`;
}
const lineOf = (source, position) => source.getLineAndCharacterOfPosition(position).line + 1;
/** First and last line of `node` when other code (not just `;` or `,`) stands on them too. */
function sharedLinesOf(source, node) {
    const text = source.text;
    const start = node.getStart(source);
    const end = node.getEnd();
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end);
    const shared = [];
    if (text.slice(lineStart, start).trim() !== '')
        shared.push(lineOf(source, start));
    if (text.slice(end, lineEnd).replace(/[\s;,]/g, '') !== '')
        shared.push(lineOf(source, end));
    return shared;
}
const bodyTextOf = (source, fn) => (fn.body ?? fn).getText(source).replace(/\s+/g, ' ').trim();
const hashOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);
export function scriptKindFor(fileName) {
    if (/\.tsx$/i.test(fileName))
        return ts.ScriptKind.TSX;
    if (/\.jsx$/i.test(fileName))
        return ts.ScriptKind.JSX;
    if (/\.[cm]?js$/i.test(fileName))
        return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}
/** Every function with a body in `text`, outer before inner. */
export function findFunctions(fileName, text) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
    const found = [];
    const visit = (node) => {
        if (isFunction(node)) {
            const bodyText = bodyTextOf(source, node);
            found.push({
                node,
                name: qualifiedName(node),
                startLine: lineOf(source, node.getStart(source)),
                endLine: lineOf(source, node.getEnd()),
                complexity: cyclomaticComplexity(node),
                nestedRanges: [],
                bodyHash: hashOf(bodyText),
                bodyText,
                sharedLines: sharedLinesOf(source, node)
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    for (const outer of found) {
        outer.nestedRanges = found
            .filter((inner) => inner !== outer && isDirectlyNested(inner.node, outer.node))
            .map((inner) => [inner.startLine, inner.endLine]);
    }
    return numberRepeatedNames(found.map(({ node: _node, ...info }) => info));
}
/**
 * Second and later functions with the same name get `#2`, `#3`, ... in source order. The number is
 * only a label: pairing with the base version matches bodies first (compare.ts).
 */
function numberRepeatedNames(functions) {
    const seen = new Map();
    return functions.map((fn) => {
        const count = (seen.get(fn.name) ?? 0) + 1;
        seen.set(fn.name, count);
        return count === 1 ? fn : { ...fn, name: `${fn.name}#${count}` };
    });
}
function isDirectlyNested(inner, outer) {
    for (let parent = inner.parent; parent; parent = parent.parent) {
        if (parent === outer)
            return true;
        if (isFunction(parent))
            return false;
    }
    return false;
}
