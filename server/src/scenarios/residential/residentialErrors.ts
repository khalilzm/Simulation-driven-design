export class ResidentialSolveError extends Error {
  constructor(message:string, public readonly report:Record<string,unknown>) { super(message); this.name='ResidentialSolveError'; }
}
