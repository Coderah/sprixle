import { getBSONDeserializer, getBSONSerializer } from '@deepkit/bson';
import { ReceiveType, resolveReceiveType } from '@deepkit/type';

/**
TODO
alright another thing I'm thinking about, new plugin for const data. basically make it really easy for data-only changes to be deployed quickly by anyone on the team. will require a new pattern for how we store things like ability blueprints but I think that's ultimately a good thing. Will make it easy to mess around locally with balance changes or even new abilities / passives. Then when we have a real production environment we can just have this functionality gated behind a PR + review workflow.
luckily we already have the ability to do binary serialization based on type
so all this plugin will do is provide aws s3 (de)serialization and deployment, and hooks for telling servers / clients theres new data (network plugin in CW's case)
it should be pretty abstracted in a way that forces us to keep our const data consistently defined
This is more or less the api I'm picturing.

import { passiveTree } from '../client/passiveTree';
import { abilityBlueprints } from './abilities';

const dataStructures = {
    abilityBlueprints,
    passiveTree,
};

const persistedData = applyPersistencePlugin(dataStructures);

export const { data, loadData, persistData, encodeData, decodeData } =
    persistedData;


so all references for abilityBlueprints become data.abilityBlueprints fairly straightforward.

This also reinforces how important it is for things to reference const data via lookup key instead of being a direct reference / copying the data. Also possible to introduce some kind of abstraction there I'm just not sure its worth the complexity yet, but it could be cool.
 */

export function applyGameDataPlugin<D>(data: D, type?: ReceiveType<D>) {
    const encodeGameData = getBSONSerializer<D>();
    const decodeGameData = getBSONDeserializer<D>();

    // TODO
    function persistGameData() {}

    // TODO
    function loadGameData() {}

    return { loadGameData, persistGameData, encodeGameData, decodeGameData };
}
