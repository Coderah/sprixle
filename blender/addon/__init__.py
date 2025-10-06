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
from . import exporter
from . import animation_clips
from deepdiff import DeepDiff
import bpy
from bpy.app.handlers import persistent
from websocket_server import WebsocketServer
import json

auto_load.init()

last_serialized_trees = {}
active_scene = None

@persistent
def checkScene():
    global server
    global active_scene
    if not bpy.context.scene == active_scene:
        active_scene = bpy.context.scene
        print('sceneChanged', active_scene)
        # TODO export scene if necessary

        if server:
            server.send_message_to_all(json.dumps({
                "name": active_scene.name,
                "type": "sceneChange"
            }, indent=0))
        else:
            print('no server to send sceneChange to')

    # print('checked scene')
    return 0.5

@persistent
def handleFileLoaded(temp):
    checkScene()

@persistent
def handleDepsGraphUpdate(scene, graph):
    global server
    checkScene()

    graphs_serialized = []
    for update in graph.updates:
        print(update, update.id)
        if isinstance(update.id, bpy.types.World):
            world = bpy.data.worlds[update.id.name]
            (data, name) = node_trees.serialize(world)

            if data and server:
                print('sending world shader', update.id.name)
                graphs_serialized.append(material)
                server.send_message_to_all(json.dumps({
                    "name": name.replace('.',''),
                    "type": 'shaderTree',
                    "data": data
                }, indent=0))

        if isinstance(update.id, bpy.types.Scene):
            scene = bpy.data.scenes[update.id.name]
            (data, name) = node_trees.serialize(scene)

            print('serialized scene compositor tree on change', update.id.name)
        
        elif isinstance(update.id, bpy.types.Material):
            material = bpy.data.materials[update.id.name]
            (data, name) = node_trees.serialize(material)

            if data and server:
                print('sending shaderTree', update.id.name)
                graphs_serialized.append(material)
                server.send_message_to_all(json.dumps({
                    "name": name,
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
        modifier = next((m for m in object.modifiers if m.type == 'NODES' and m.node_group and '+logic' in m.node_group.name), None)
        if modifier is None:
            continue
        
        if not modifier.node_group.name in (update.id.name for update in graph.updates): continue
        if modifier in graphs_serialized: continue

    
        print('logic tree update for')
        print(object)
        
        # print(json)
        (data, name) = node_trees.serialize(object)

        # last_serialized_trees[object.name]

        if data and server:
            graphs_serialized.append(modifier)
            server.send_message_to_all(json.dumps({
                 "name": name.replace('.', ''),
                 "type": 'logicTree',
                 "data": data
            }, indent=0))

def prepAllNodeTrees():
    logicObjects = {}
    materials = {}
    handledTreeParent = []

    for object in bpy.context.scene.objects:
        if object.name in handledTreeParent: continue
        handledTreeParent.append(object.name)
        (data, name) = node_trees.serialize(object)
        if data:
            logicObjects[name] = data

        for material_slot in object.material_slots:
            material = material_slot.material
            if material == None or not material or material.name in handledTreeParent: continue
            handledTreeParent.append(material.name)
            (data, name) = node_trees.serialize(material)

            if data:
                materials[name] = data

    (sceneData, compositorName) = node_trees.serialize(bpy.context.scene)
    if sceneData:
        materials[compositorName] = sceneData

    return (logicObjects, materials)
    

# Called for every client connecting (after handshake)
@persistent
def new_client(client, server):
    print("New client connected and was given id %d" % client['id'])
    server.send_message_to_all(json.dumps({
        "type": "sceneChange",
        "name": bpy.context.scene.name
    }))

    (logicObjects, materials) = prepAllNodeTrees()

    for material in materials:
        print('sending shaderTree', material)
        server.send_message_to_all(json.dumps({
            "name": material,
            "type": 'shaderTree',
            "data": materials[material]
        }, indent=0))

    for object in logicObjects:
        server.send_message_to_all(json.dumps({
            "name": object.replace('.', ''),
            "type": 'logicTree',
            "data": logicObjects[object]
        }, indent=0))


# Called for every client disconnecting
@persistent
def client_left(client, server):
    print("Client(%d) disconnected" % client['id'])


# Called when a client sends a message
@persistent
def message_received(client, server, message):
    if len(message) > 200:
        message = message[:200]+'..'
    print("Client(%d) said something: %s" % (client['id'], message))


PORT=9001
server = False

class SprixleExport(bpy.types.Operator):
    """Uses Sprixle addon's export for the current scene"""      # Use this as a tooltip for menu items and buttons.
    bl_idname = "export.sprixle_export"        # Unique identifier for buttons and menu items to reference.
    bl_label = "Sprixle Export (.glb)"         # Display name in the interface.

    def execute(self, context):        # execute() is called when running the operator.
        prepAllNodeTrees()
        animation_clips.prepare_animation_properties()
        
        exporter.export(bpy.context.scene.name)

        global server
        if server:
            server.send_message_to_all(json.dumps({
                "type": "export",
                "name": bpy.context.scene.name
            }))

        return {'FINISHED'}            # Lets Blender know the operator finished successfully.


def menu_func_export(self, context):
    self.layout.operator(SprixleExport.bl_idname, text="Sprixle Export (.glb)")

class SprixleInfoPanel(bpy.types.Panel):
    bl_idname = "OBJECT_PT_sprixle"
    bl_category = 'Sprixle'
    bl_label = "Version"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_context = "objectmode"

    def draw(self, context):
        global active_scene
        self.layout.label(text="Addon Version: 0.0.8")

        self.layout.operator(SprixleExport.bl_idname, text="Export Scene", icon="EXPORT")

class SprixleInfoPanelInTree(bpy.types.Panel):
    bl_idname = "TREE_PT_sprixle"
    bl_category = 'Sprixle'
    bl_label = "Version"
    bl_space_type = 'NODE_EDITOR'
    bl_region_type = 'UI'
    bl_context = "objectmode"

    def draw(self, context):
        global active_scene
        self.layout.label(text="Addon Version: 0.0.8")

        self.layout.operator(SprixleExport.bl_idname, text="Export Scene", icon="EXPORT")


def register():
    auto_load.register()
    bpy.app.handlers.depsgraph_update_post.append(handleDepsGraphUpdate)
    bpy.app.handlers.load_post.append(handleFileLoaded)
    bpy.app.timers.register(checkScene, first_interval = 0.5, persistent=True)
    # exporter.register()

    # bpy.utils.unregister_class(SprixleExport)
    bpy.utils.register_class(SprixleExport)
    bpy.utils.register_class(SprixleInfoPanel)
    bpy.utils.register_class(SprixleInfoPanelInTree)
    # bpy.types.TOPBAR_MT_file_export.append(menu_func_export)

    global server
    server = WebsocketServer(host = '0.0.0.0', port = PORT)
    server.set_fn_new_client(new_client)
    server.set_fn_client_left(client_left)
    server.set_fn_message_received(message_received)
    server.run_forever(threaded=True)


def unregister():
    auto_load.unregister()
    global server
    if server:
        server.shutdown_gracefully()
        server = False
    # exporter.unregister()
    bpy.app.handlers.depsgraph_update_post.remove(handleDepsGraphUpdate)
    bpy.app.handlers.load_post.remove(handleFileLoaded)
    bpy.app.timers.unregister(checkScene)

    bpy.utils.unregister_class(SprixleExport)
    bpy.utils.unregister_class(SprixleInfoPanel)
    bpy.utils.unregister_class(SprixleInfoPanelInTree)
    # bpy.types.TOPBAR_MT_file_export.remove(menu_func_export)

