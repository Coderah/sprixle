import { Immutable } from './imm';
import { EntityAdminState } from './manager';

export default abstract class System {
	static phase: 'pre' | 'body' | 'post';

	static update(entityAdmin: Immutable<EntityAdminState<any>>, delta: number, now: number): Immutable<EntityAdminState<any>> {
		return entityAdmin;
	}
}