# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTIBILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <http://www.gnu.org/licenses/>.

from . import auto_load
from . import node_trees
from deepdiff import DeepDiff
import bpy
from bpy.app.handlers import persistent
from websocket_server import WebsocketServer
import json

auto_load.init()

last_serialized_trees = {}

@persistent
def handleDepsGraphUpdate(scene, graph):
    global server
    graphs_serialized = []
    for update in graph.updates:
        print(update)
        if isinstance(update.id, bpy.types.Material):
            print('shading', update.is_updated_shading)
            material = bpy.data.materials[update.id.name]
            data = node_trees.serialize(material)

            if data and server:
                graphs_serialized.append(material)
                server.send_message_to_all(json.dumps({
                    "name": update.id.name.replace('.', ''),
                    "type": 'shaderTree',
                    "data": data
                }, indent=0))

            # TODO define and send update types?
            # if update.id.name in last_serialized_trees:
                # print(DeepDiff(last_serialized_trees[update.id.name], data))

            # last_serialized_trees[update.id.name] = data
    for object in graph.objects:
        object = bpy.data.objects[object.name]
        if not hasattr(object, 'modifiers'): continue
        modifier = next((m for m in object.modifiers if m.type == 'NODES' and '+logic' in m.node_group.name), None)
        if modifier is None:
            continue
        
        if not modifier.node_group.name in (update.id.name for update in graph.updates): continue
        if modifier in graphs_serialized: continue

    
        print('logic tree update for')
        print(object)
        
        # print(json)
        data = node_trees.serialize(object)

        # last_serialized_trees[object.name]

        if data and server:
            graphs_serialized.append(modifier)
            server.send_message_to_all(json.dumps({
                 "name": object.name.replace('.', ''),
                 "type": 'logicTree',
                 "data": data
            }, indent=0))


# Called for every client connecting (after handshake)
def new_client(client, server):
    print("New client connected and was given id %d" % client['id'])
    for material in bpy.data.materials:
        data = node_trees.serialize(material)

        if data and server:
            server.send_message_to_all(json.dumps({
                "name": material.name.replace('.', ''),
                "type": 'shaderTree',
                "data": data
            }, indent=0))

    for object in bpy.data.objects:
        data = node_trees.serialize(object)

        if data and server:
            server.send_message_to_all(json.dumps({
                "name": object.name.replace('.', ''),
                "type": 'logicTree',
                "data": data
            }, indent=0))


# Called for every client disconnecting
def client_left(client, server):
    print("Client(%d) disconnected" % client['id'])


# Called when a client sends a message
def message_received(client, server, message):
    if len(message) > 200:
        message = message[:200]+'..'
    print("Client(%d) said something: %s" % (client['id'], message))


PORT=9001
server = False

def register():
    auto_load.register()
    bpy.app.handlers.depsgraph_update_post.append(handleDepsGraphUpdate)

    global server
    server = WebsocketServer(port = PORT)
    server.set_fn_new_client(new_client)
    server.set_fn_client_left(client_left)
    server.set_fn_message_received(message_received)
    server.run_forever(threaded=True)


def unregister():
    auto_load.unregister()
    bpy.app.handlers.depsgraph_update_post.remove(handleDepsGraphUpdate)

    global server
    if server:
        server.shutdown_gracefully()
        server = False
