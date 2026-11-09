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
    ts.SyntaxKind.QuestionQuestionToken
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
/** `app.get(callback)` for a function passed to a call; long callees are shortened. */
function callbackName(node) {
    const call = node.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === node))
        return undefined;
    const callee = call.expression.getText().replace(/\s+/g, '');
    return `${callee.length > 40 ? `${callee.slice(0, 39)}…` : callee}(callback)`;
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
    return callbackName(node);
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
function bodyHash(source, fn) {
    const text = (fn.body ?? fn).getText(source).replace(/\s+/g, ' ').trim();
    return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
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
            .map((inner) => [inner.startLine, inner.endLine]);
    }
    return numberRepeatedNames(found.map(({ node: _node, ...info }) => info));
}
/** Second and later functions with the same name get `#2`, `#3`, ... in source order. */
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
