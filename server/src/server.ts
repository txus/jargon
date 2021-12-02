import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	InitializeResult,
	WorkspaceFolder,
	CodeAction,
	Command,
	CodeActionKind
} from 'vscode-languageserver/node';

import * as fs from "fs";

import uri2path from 'file-uri-to-path';

import * as YAML from 'yaml';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { ClientRequest } from 'http';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

type Namespace = {
	name: string,
	terms: Array<Term>
	knownTerms: Array<string>
};

type Term = {
	lowercaseName: string,
	name: string,
	aka: string[],
	description?: string
};

class Glossary {
	namespaces: Array<Namespace> = [];

	isEmpty(): boolean {
		return this.namespaces.length === 0;
	}

	markAsKnown(nsName: string, termName: string) {
		const ns = this.getOrCreateNamespace(nsName);
		ns.knownTerms.push(termName);
	}

	set(nsName: string, term: Term) {
		const ns = this.getOrCreateNamespace(nsName);
		ns.terms.push(term);
	}

	resolve(query: string, path: string): [Term, Namespace] | undefined {
		let ns: Namespace;
		const matchingNamespaces = this.namespaces.filter(ns => path.includes(ns.name));
		if (matchingNamespaces.length > 1) {
			throw new Error(`Ambiguity found for ${query} in ${path}. Name your namespaces more concretely. Possible namespaces are: ${matchingNamespaces.map(x => x.name)}`);
		} else if (matchingNamespaces.length === 0) {
			ns = this.globalNamespace();
		} else {
			ns = matchingNamespaces[0];
		}

		query = query.toLowerCase();

		const found = ns.terms.find(t => t.lowercaseName === query) || ns.terms.find(t => (t.lowercaseName + 's') == query);

		if (found && !ns.knownTerms.includes(found.name)) {
			return [found, ns];
		}
	}
	clear() {
		this.namespaces = [{name: 'global', terms: [], knownTerms: []}];
	}

	private globalNamespace(): Namespace {
		return this.namespaces[0];
	}

	private getOrCreateNamespace(nsName: string): Namespace {
		let ns = this.namespaces.find(ns => ns.name === nsName);
		if (!ns) {
			ns = {
				name: nsName,
				terms: [],
				knownTerms: []
			};
			this.namespaces.push(ns);
		}
		return ns;
	}
}

let glossary = new Glossary();

function compileGlossary(jargonFilePaths: string[]): Glossary {
	const glossary = new Glossary();
	jargonFilePaths.forEach(jargonFilePath => {
		const jargonPath = uri2path(jargonFilePath + '/.jargon.yml');
		if (fs.existsSync(jargonPath)) {
			const file = fs.readFileSync(jargonPath, 'utf8');
			const doc = YAML.parse(file);
			for (const [nsName, nsTerms] of Object.entries(doc)) {
				for (const [termName, value] of Object.entries(nsTerms as any)) {
					const v = value as any;
					const termAka = v['aka'];
					const termDesc = v['description'];
					let aka: string[] = [];
					if (typeof termAka === 'string') {
						aka.push(termAka);
					} else if (Array.isArray(termAka)) {
						aka = termAka;
					}

					glossary.set(nsName, { lowercaseName: termName.toLowerCase(), name: termName, aka, description: termDesc });
					aka.forEach(a => {
						const otherAkas = aka.filter(x => x !== a);
						glossary.set(nsName, { lowercaseName: a.toLowerCase(), name: a, aka: [termName, ...otherAkas], description: termDesc });
					});
				}
			}
		}

		const knownPath = uri2path(jargonFilePath + '/.jargon.known.yml');
		if (fs.existsSync(knownPath)) {
			const file = fs.readFileSync(knownPath, 'utf8');
			const doc = YAML.parse(file);
			for (const [nsName, nsTerms] of Object.entries(doc)) {
				(nsTerms as Array<string>).forEach(termName => {
					glossary.markAsKnown(nsName, termName);
				});
			}
		}
	});
	return glossary;
}

function compileGlossaryFromWorkspaceFolders(workspaceFolders: WorkspaceFolder[]): Glossary {
	return compileGlossary(workspaceFolders.map(folder => folder.uri));
}

connection.onInitialize((params: InitializeParams) => {
	if (params.workspaceFolders) {
		glossary = compileGlossaryFromWorkspaceFolders(params.workspaceFolders);
	} else {
		glossary = compileGlossary([params.rootPath!]);
	}

	if (glossary.isEmpty()) {
		console.error(params.workspaceFolders);
		throw new Error('No .jargon.yml files were found. This is probably a bug in the extension or language server.');
	}

	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			codeActionProvider: true,
			executeCommandProvider: {
				commands: ['jargon.markAsKnown']
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

function reloadGlossary(folders: WorkspaceFolder[]) {
	glossary = compileGlossaryFromWorkspaceFolders(folders);
	documents.all().forEach(validateTextDocument);
}

connection.onInitialized(() => {
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
			connection.workspace.getWorkspaceFolders().then(folders => {
				if (folders) {
					reloadGlossary(folders);
				}
			});
		});
	}
});


// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});


async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	if (textDocument.uri.endsWith('.jargon.yml') || textDocument.uri.endsWith('.jargon.known.yml')) {
		return;
	}

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	const pattern = /[a-zA-Z][a-zA-Z-_]+/g;
	let m: RegExpExecArray | null;

	const diagnostics: Diagnostic[] = [];
	while ((m = pattern.exec(text))) {

		const found = glossary.resolve(m[0], textDocument.uri);
		if (found) {
			const [term, ns] = found;
			const parts = [];
			if (term.aka.length > 0) {
				const aka = term.aka.map(x => `**${x}**`).join(', ');
				parts.push(`Also known as ${aka}.`);
			}
			if (term.description !== undefined) {
				parts.push(term.description);
			}

			const message = parts.join('\n\n');
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Information,
				range: {
					start: textDocument.positionAt(m.index),
					end: textDocument.positionAt(m.index + m[0].length)
				},
				message: message,
				source: 'jargon',
				data: {
					termName: term.name,
					namespaceName: ns.name
				}
			};
			if (hasDiagnosticRelatedInformationCapability) {
				diagnostic.relatedInformation = [];
			}

			diagnostics.push(diagnostic);
		}
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(change => {
	connection.console.log('.jargon.yml or .jargon.known.yml changed');
	connection.workspace.getWorkspaceFolders().then(folders => {
		if (folders) {
			reloadGlossary(folders);
			connection.window.showInformationMessage(`Jargon glossary reloaded.`);
		}
	});
});

connection.onCodeAction(params => {
	const diagnostics = params.context.diagnostics;
    if (!diagnostics || diagnostics.length === 0) {
        return [];
    }

	const textDocument = documents.get(params.textDocument.uri);
	if (textDocument === undefined) {
		return undefined;
	}

	const codeActions: CodeAction[] = [];
    diagnostics.forEach((diag) => {
		if (diag.source === 'jargon') {
			codeActions.push({
				title: 'Mark as known',
				kind: CodeActionKind.QuickFix,
				diagnostics: [diag],
				command: Command.create('Mark as known', 'jargon.markAsKnown', (diag.data! as any))
			});
		}
	});
	return codeActions;
});

connection.onExecuteCommand(async (params) => {
	if (params.command !== 'jargon.markAsKnown' || params.arguments === undefined) {
		return;
	}
	const args = params.arguments[0];
	const termName = args.termName;
	const namespaceName = args.namespaceName;

	connection.window.showInformationMessage(`Jargon won't underline '${termName}' for you anymore in this context. If you change your mind, you can delete it from .jargon.known.yml at the root of your workspace.`);

	connection.workspace.getWorkspaceFolders().then(folders => {
		if (folders) {
			const firstFolder = folders[0];
			const knownPath = uri2path(firstFolder.uri + '/.jargon.known.yml');
			const nsToKnown: any = {};
			if (fs.existsSync(knownPath)) {
				const file = fs.readFileSync(knownPath, 'utf8');
				const doc = YAML.parse(file);

				for (const [nsName, nsTerms] of Object.entries(doc)) {
					nsToKnown[nsName] = (nsTerms as Array<string>);
				}
				// add the new word as known
				if (!(nsToKnown[namespaceName] || []).includes(termName)) {
					nsToKnown[namespaceName] = (nsToKnown[namespaceName] || []).concat(termName);
				}
				console.log(nsToKnown);

				const toWrite = YAML.stringify(nsToKnown);
				fs.writeFileSync(knownPath, toWrite);
			}
		}
	});
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
