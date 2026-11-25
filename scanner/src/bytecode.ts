// Turns a compiled Move module into a model with every table index resolved
// to a name, so two compilations of the same source produce the same text
// even when their internal tables are laid out differently.

import { createHash } from 'node:crypto';
import { deserialize } from '@mysten/move-bytecode-template';

const ABILITY_KEY = 0x8;

/** Top bit of a u64 abort code marks a "clever error", which embeds a source line number. */
const CLEVER_ERROR_TAG = 1n << 63n;

export interface TypeRef {
	/** `&`, `&mut`, or by value. */
	ref: 'imm' | 'mut' | 'value';
	/** Set when the type is a struct or enum. */
	datatype?: { address: string; module: string; name: string; hasKey: boolean };
	/** Printable form, for example `&mut 0x2::coin::Coin<T0>`. */
	repr: string;
}

export interface CallRef {
	address: string;
	module: string;
	name: string;
}

export interface FieldRef {
	struct: string;
	field: string;
}

export interface FunctionModel {
	module: string;
	name: string;
	visibility: 'Public' | 'Private' | 'Friend';
	isEntry: boolean;
	params: TypeRef[];
	/** Functions this one calls directly. */
	calls: CallRef[];
	/** Struct fields this one borrows directly. */
	fields: FieldRef[];
	/** True when the body takes a mutable borrow of a struct field. Only the defining package can do this, so it is how a package changes its own objects. */
	mutatesFields: boolean;
	/** True when the body has no return instruction, so every call aborts. */
	alwaysAborts: boolean;
	/** Hash of the normalised body. Equal hashes mean equal logic. */
	bodyHash: string;
}

export interface ModuleModel {
	/** The package address written inside the bytecode (the original package ID). */
	address: string;
	name: string;
	functions: FunctionModel[];
}

type Json = any;

export function parseModule(bytes: Uint8Array): ModuleModel {
	const m: Json = deserialize(bytes);

	const ident = (i: number): string => m.identifiers[i];
	const moduleOf = (i: number) => {
		const h = m.module_handles[i];
		return { address: '0x' + m.address_identifiers[h.address], module: ident(h.name) };
	};
	const datatype = (i: number) => {
		const h = m.datatype_handles[i];
		return { ...moduleOf(h.module), name: ident(h.name), hasKey: (h.abilities & ABILITY_KEY) !== 0 };
	};
	const self = moduleOf(m.self_module_handle_idx);

	const typeRepr = (tok: Json): string => {
		if (typeof tok === 'string') return tok.toLowerCase();
		if ('Vector' in tok) return `vector<${typeRepr(tok.Vector)}>`;
		if ('Reference' in tok) return `&${typeRepr(tok.Reference)}`;
		if ('MutableReference' in tok) return `&mut ${typeRepr(tok.MutableReference)}`;
		if ('TypeParameter' in tok) return `T${tok.TypeParameter}`;
		if ('Datatype' in tok) {
			const d = datatype(tok.Datatype);
			return `${d.address}::${d.module}::${d.name}`;
		}
		if ('DatatypeInstantiation' in tok) {
			const [idx, args] = tok.DatatypeInstantiation;
			const d = datatype(idx);
			return `${d.address}::${d.module}::${d.name}<${args.map(typeRepr).join(', ')}>`;
		}
		return JSON.stringify(tok);
	};
	const typeRef = (tok: Json): TypeRef => {
		let ref: TypeRef['ref'] = 'value';
		let inner = tok;
		if (typeof tok === 'object' && 'Reference' in tok) {
			ref = 'imm';
			inner = tok.Reference;
		} else if (typeof tok === 'object' && 'MutableReference' in tok) {
			ref = 'mut';
			inner = tok.MutableReference;
		}
		let dt: TypeRef['datatype'];
		if (typeof inner === 'object' && 'Datatype' in inner) dt = datatype(inner.Datatype);
		if (typeof inner === 'object' && 'DatatypeInstantiation' in inner)
			dt = datatype(inner.DatatypeInstantiation[0]);
		return { ref, datatype: dt, repr: typeRepr(tok) };
	};
	const signature = (i: number): string => m.signatures[i].map(typeRepr).join(', ');

	const callRef = (handleIdx: number): CallRef => {
		const h = m.function_handles[handleIdx];
		return { ...moduleOf(h.module), name: ident(h.name) };
	};
	const structDefName = (defIdx: number): string => datatype(m.struct_defs[defIdx].struct_handle).name;
	const fieldRef = (handleIdx: number): FieldRef => {
		const h = m.field_handles[handleIdx];
		const def = m.struct_defs[h.owner];
		const declared = def.field_information?.Declared ?? [];
		return { struct: structDefName(h.owner), field: ident(declared[h.field].name) };
	};
	const enumName = (defIdx: number): string => datatype(m.enum_defs[defIdx].enum_handle).name;
	const variant = (handleIdx: number): string => {
		const h = m.variant_handles[handleIdx];
		return `${enumName(h.enum_def)}#${h.variant}`;
	};

	const functions: FunctionModel[] = m.function_defs.map((def: Json) => {
		const handle = m.function_handles[def.function];
		const calls: CallRef[] = [];
		const fields: FieldRef[] = [];
		const text: string[] = [];
		const code: Json[] = def.code?.code ?? [];
		let mutatesFields = false;
		let returns = false;

		code.forEach((ins, pc) => {
			if (typeof ins === 'string') {
				if (ins === 'Ret') returns = true;
				text.push(ins);
				return;
			}
			const [op, arg] = Object.entries(ins)[0] as [string, Json];
			switch (op) {
				case 'Call': {
					const c = callRef(arg);
					calls.push(c);
					text.push(`Call ${c.address}::${c.module}::${c.name}`);
					break;
				}
				case 'CallGeneric': {
					const inst = m.function_instantiations[arg];
					const c = callRef(inst.handle);
					calls.push(c);
					text.push(`Call ${c.address}::${c.module}::${c.name}<${signature(inst.type_parameters)}>`);
					break;
				}
				case 'ImmBorrowField':
				case 'MutBorrowField': {
					if (op === 'MutBorrowField') mutatesFields = true;
					const f = fieldRef(arg);
					fields.push(f);
					text.push(`${op} ${f.struct}.${f.field}`);
					break;
				}
				case 'ImmBorrowFieldGeneric':
				case 'MutBorrowFieldGeneric': {
					if (op === 'MutBorrowFieldGeneric') mutatesFields = true;
					const inst = m.field_instantiations[arg];
					const f = fieldRef(inst.handle);
					fields.push(f);
					text.push(`${op} ${f.struct}.${f.field}<${signature(inst.type_parameters)}>`);
					break;
				}
				case 'Pack':
				case 'Unpack':
					text.push(`${op} ${structDefName(arg)}`);
					break;
				case 'PackGeneric':
				case 'UnpackGeneric': {
					const inst = m.struct_def_instantiations[arg];
					text.push(`${op} ${structDefName(inst.def)}<${signature(inst.type_parameters)}>`);
					break;
				}
				case 'PackVariant':
				case 'UnpackVariant':
				case 'UnpackVariantImmRef':
				case 'UnpackVariantMutRef':
					text.push(`${op} ${variant(arg)}`);
					break;
				case 'PackVariantGeneric':
				case 'UnpackVariantGeneric':
				case 'UnpackVariantGenericImmRef':
				case 'UnpackVariantGenericMutRef': {
					const inst = m.variant_instantiation_handles[arg];
					const enumInst = m.enum_def_instantiations[inst.enum_def];
					text.push(
						`${op} ${enumName(enumInst.def)}#${inst.variant}<${signature(enumInst.type_parameters)}>`,
					);
					break;
				}
				case 'LdConst': {
					const c = m.constant_pool[arg];
					text.push(`LdConst ${typeRepr(c.type_)} ${Buffer.from(c.data).toString('hex')}`);
					break;
				}
				case 'LdU64': {
					const next = code[pc + 1];
					const value = BigInt(arg);
					// The line number inside a clever error changes whenever the
					// source file is edited above it, so it says nothing about logic.
					if (next === 'Abort' && (value & CLEVER_ERROR_TAG) !== 0n) text.push('LdU64 <clever-error>');
					else text.push(`LdU64 ${value}`);
					break;
				}
				case 'VecPack':
				case 'VecUnpack':
					text.push(`${op} ${signature(arg[0])} ${arg[1]}`);
					break;
				case 'VecLen':
				case 'VecImmBorrow':
				case 'VecMutBorrow':
				case 'VecPushBack':
				case 'VecPopBack':
				case 'VecSwap':
					text.push(`${op} ${signature(arg)}`);
					break;
				default:
					// Locals, branch targets and small literals: already position independent.
					text.push(`${op} ${typeof arg === 'bigint' ? arg.toString() : JSON.stringify(arg)}`);
			}
		});

		const locals = def.code ? signature(def.code.locals) : '';
		const params = m.signatures[handle.parameters].map(typeRef);
		const header = [
			`params ${params.map((p: TypeRef) => p.repr).join(', ')}`,
			`returns ${signature(handle.return_)}`,
			`locals ${locals}`,
		];
		return {
			module: self.module,
			name: ident(handle.name),
			visibility: def.visibility,
			isEntry: def.is_entry,
			params,
			calls,
			fields,
			mutatesFields,
			// Native functions have no code; they do return.
			alwaysAborts: !!def.code && !returns,
			bodyHash: createHash('sha256').update([...header, ...text].join('\n')).digest('hex'),
		} satisfies FunctionModel;
	});

	return { address: self.address, name: self.module, functions };
}
