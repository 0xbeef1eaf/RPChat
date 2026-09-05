import { RpError } from '@rp/shared';
import type { CapabilityMethodSpec, CapabilityModuleSpec, PermissionLevel } from '@rp/shared';
import { validateModuleSpec } from './validate.js';

/**
 * Ordered collection of capability module specs. Registration order is the
 * order used everywhere (typings, docs, surface), so the standard modules keep
 * a stable, predictable layout in the prompt.
 */
export class CapabilityRegistry {
  private readonly specs = new Map<string, CapabilityModuleSpec>();

  /**
   * Register a module. Throws `RpError('INVALID_ARGUMENT')` when the spec is
   * invalid (see `validateModuleSpec`) or a module with the same id exists.
   */
  register(spec: CapabilityModuleSpec): void {
    const problems = validateModuleSpec(spec);
    if (problems.length > 0) {
      throw new RpError('INVALID_ARGUMENT', `Invalid capability module spec "${String(spec?.id)}": ${problems.join('; ')}`, {
        module: spec?.id,
        problems,
      });
    }
    if (this.specs.has(spec.id)) {
      throw new RpError('INVALID_ARGUMENT', `Capability module "${spec.id}" is already registered`, { module: spec.id });
    }
    this.specs.set(spec.id, spec);
  }

  get(id: string): CapabilityModuleSpec | undefined {
    return this.specs.get(id);
  }

  has(id: string): boolean {
    return this.specs.has(id);
  }

  /** All registered modules in registration order. */
  list(): CapabilityModuleSpec[] {
    return [...this.specs.values()];
  }

  /** Effective permission for a method: the method override, or the module default. Throws `CAPABILITY_UNKNOWN`. */
  permissionFor(module: string, method: string): PermissionLevel {
    const spec = this.require(module);
    return this.methodSpec(module, method).permission ?? spec.permission;
  }

  /** The `CapabilityMethodSpec` of `module.method` (dotted names for nested members). Throws `CAPABILITY_UNKNOWN`. */
  methodSpec(module: string, method: string): CapabilityMethodSpec {
    const spec = this.require(module);
    const m = Object.prototype.hasOwnProperty.call(spec.methods, method) ? spec.methods[method] : undefined;
    if (!m) {
      throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.${module}.${method}`, { module, method });
    }
    return m;
  }

  private require(module: string): CapabilityModuleSpec {
    const spec = this.specs.get(module);
    if (!spec) throw new RpError('CAPABILITY_UNKNOWN', `Unknown capability module "${module}"`, { module });
    return spec;
  }
}
