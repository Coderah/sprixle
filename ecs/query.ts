import { defaultComponentTypes, entityId, Keys, Manager } from './manager';

export type QueryName = string;

export type QueryParameters<ComponentTypes> = {
    flexible?: boolean;
    includes?: Set<Keys<ComponentTypes>>;
    excludes?: Set<Keys<ComponentTypes>>;
};

export type QueryParametersInput<ComponentTypes> = {
    flexible?: boolean;
    includes?: Keys<ComponentTypes>[];
    excludes?: Keys<ComponentTypes>[];
};

export class Query<ExactComponentTypes extends defaultComponentTypes> {
    manager: Manager<ExactComponentTypes>;
    queryName: QueryName;

    queryParameters: QueryParameters<Partial<ExactComponentTypes>>;
    entities = new Set<entityId>();
    consumers = new Array<Consumer<ExactComponentTypes>>();

    constructor(
        manager: Manager<ExactComponentTypes>,
        parameters: QueryParametersInput<Partial<ExactComponentTypes>>
    ) {
        this.manager = manager;

        this.queryName = '';

        this.queryParameters = { flexible: parameters.flexible };

        if (parameters.includes) {
            const includesArray = parameters.includes.sort((a, b) =>
                a.toString()[0] > b.toString()[0] ? 1 : -1
            );
            this.queryName += includesArray
                .map((c) => '+' + c.toString())
                .join(',');

            this.queryParameters.includes = new Set(parameters.includes);
        }
        if (parameters.excludes) {
            const excludesArray = parameters.excludes.sort((a, b) =>
                a.toString()[0] > b.toString()[0] ? 1 : -1
            );
            if (this.queryName) this.queryName += ',';
            this.queryName += excludesArray
                .map((c) => '-' + c.toString())
                .join(',');

            this.queryParameters.excludes = new Set(parameters.excludes);
        }

        // TODO: handle existing entities
        manager.state.entities.forEach((entity) => {
            if (this.entityMatches(entity)) this.addEntity(entity);
        });
    }

    componentMatches(component: keyof typeof this.manager.ComponentTypes) {
        return this.queryParameters.includes
            ? this.queryParameters.includes.has(component)
            : this.queryParameters.excludes
            ? !this.queryParameters.excludes.has(component)
            : true;
    }

    entityMatches(entity: typeof this.manager.Entity) {
        if (
            this.queryParameters.includes &&
            (this.queryParameters.flexible
                ? !this.queryParameters.includes.some(
                      (component) => component in entity.components
                  )
                : !this.queryParameters.includes.every(
                      (component) => component in entity.components
                  ))
        )
            return false;
        if (
            this.queryParameters.excludes &&
            this.queryParameters.excludes.some(
                (component) => component in entity.components
            )
        )
            return false;

        return true;
    }

    createConsumer() {
        const newConsumer = new Consumer(this);
        this.consumers.push(newConsumer);
        return newConsumer;
    }

    private indexEntity(entity: typeof this.manager.Entity) {
        this.entities.add(entity.id);
    }

    handleEntity(entity: typeof this.manager.Entity) {
        const matches = this.entityMatches(entity);

        if (this.entities.has(entity.id)) {
            if (!matches) {
                console.log(
                    '[QUERY]',
                    this.queryName,
                    'removed entity',
                    entity.id
                );
                this.removeEntity(entity);
            } else {
                console.log(
                    '[QUERY]',
                    this.queryName,
                    'updated entity',
                    entity.id
                );
                this.updatedEntity(entity);
            }
        } else if (matches) {
            console.log('[QUERY]', this.queryName, 'added entity', entity.id);
            this.addEntity(entity);
        }
    }

    addEntity(entity: typeof this.manager.Entity) {
        this.consumers.forEach((c) => c.add(entity.id));
        this.indexEntity(entity);

        if (!this.manager.state.queryMap.has(entity.id)) {
            this.manager.state.queryMap.set(entity.id, new Set());
        }
        this.manager.state.queryMap.get(entity.id)?.add(this.queryName);
    }

    updatedEntity(entity: typeof this.manager.Entity) {
        if (!this.entities.has(entity.id)) return;
        this.consumers.forEach((c) => {
            c.updatedEntities.add(entity.id);
            c.consumedEntities.delete(entity.id);
        });
    }

    removeEntity(entity: typeof this.manager.Entity) {
        this.entities.delete(entity.id);
        this.consumers.forEach((c) => {
            c.newEntities.delete(entity.id);
            c.updatedEntities.delete(entity.id);
            c.deletedEntities.add(entity);
        });

        this.manager.state.queryMap.get(entity.id)?.delete(this.queryName);
    }

    for(handler: (entity: typeof this.manager.Entity) => boolean | void) {
        this.entities.forEach((id) => {
            return handler(this.manager.getEntity(id, true));
        });
    }

    find(handler: (entity: typeof this.manager.Entity) => boolean) {
        let foundEntity: typeof this.manager.Entity;

        this.for((possibleEntity) => {
            if (handler(possibleEntity)) {
                foundEntity = possibleEntity;
                return true;
            }
        });

        return foundEntity;
    }

    tick() {
        this.consumers.forEach((c) => c.tick());
    }
}

/** Consumers track updated and new entities until consumed for a given Query */
class Consumer<ExactComponentTypes extends defaultComponentTypes> {
    query: Query<ExactComponentTypes>;
    updatedEntities = new Set<entityId>();
    newEntities = new Set<entityId>();
    deletedEntities = new Set<typeof this.query.manager.Entity>();

    consumed = false;
    consumedEntities = new Set<entityId>();

    constructor(query: Query<ExactComponentTypes>) {
        this.query = query;

        if (query.entities.size) {
            query.entities.forEach(this.add);
        }
    }

    /** called by Query when adding an entity, for internal use */
    add(id: entityId) {
        this.newEntities.add(id);
        // this.updated(id);
    }

    /** called by Query when updating an entity, for internal use */
    updated(id: entityId) {
        this.updatedEntities.add(id);
    }

    remove(entity: typeof this.query.manager.Entity) {
        this.updatedEntities.delete(entity.id);
        this.newEntities.delete(entity.id);
        this.deletedEntities.add(entity);
    }

    // for(handler: (entity: typeof this.query.manager.Entity) => boolean | void) {
    //     this.query.for(handler);
    // }

    forUpdated(
        handler: (entity: typeof this.query.manager.Entity) => boolean | void
    ) {
        this.consumed = true;

        this.updatedEntities.forEach((id) => {
            this.updatedEntities.delete(id);
            // this.consumedEntities.add(id);
            return handler(this.query.manager.getEntity(id, true));
        });
    }

    forNew(
        handler: (entity: typeof this.query.manager.Entity) => boolean | void
    ) {
        this.consumed = true;

        this.newEntities.forEach((id) => {
            this.newEntities.delete(id);
            return handler(this.query.manager.getEntity(id, true));
        });
    }

    forDeleted(
        handler: (entity: typeof this.query.manager.Entity) => boolean | void
    ) {
        this.consumed = true;

        this.deletedEntities.forEach((entity) => {
            this.deletedEntities.delete(entity);
            return handler(entity);
        });
    }

    tick() {
        if (this.consumed) {
            // this.newEntities.clear();
            // this.deletedEntities.clear();
            // this.consumedEntities.forEach((id) => {
            //     this.updatedEntities.delete(id);
            // });
            // this.consumedEntities.clear();
        }
    }
}

/*
TODO:
* figure out how to provide exact types to consumers/queries so there is no "this might not exist" for component lookups
* figure out if there is a way to optimize query being used in multiple systems?
* utilize bitmasks for faster matching and queries
* do we update queries in realtime? or delay/commit them on tick
* handle removal / deregistering an entity
* make sure entities can't hangout or be re-indexed if they're not registered
*/
