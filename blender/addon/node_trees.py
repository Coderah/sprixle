import bpy
import json
import mathutils
import os
import re
import hashlib

def is_struct(val):
    return val.__class__.__name__ == "bpy_prop_array" or isinstance(val, bpy.types.bpy_struct)

vector_space_rules = {
    'output_spaces': {
        'R_LAYERS': {'__ALL__': 'OBJECT'},
        'CompositorNodeImageCoordinates': {'__ALL__': 'UV'},
        'CompositorNodeImageInfo': {'__ALL__': 'UV'},

        # Texture Coordinate Node
        'TEX_COORD': {
            'UV': 'UV',
            'Object': 'OBJECT',
            'Camera': 'CAMERA',
            'Window': 'SCREEN',
            'Normal': 'OBJECT_NORMAL',
            'Reflection': 'WORLD_REFLECTION',
            'Generated': 'OBJECT_GENERATED'
        },
        
        # Input Nodes
        'TEX_IMAGE': {'__ALL__': 'UV'},
        'TEX_NOISE': {'__ALL__': 'OBJECT'},
        'TEX_VORONOI': {'__ALL__': 'OBJECT'},
        'TEX_MUSGRAVE': {'__ALL__': 'OBJECT'},
        'TEX_WAVE': {'__ALL__': 'OBJECT'},
        'TEX_GRADIENT': {'__ALL__': 'OBJECT'},
        'TEX_CHECKER': {'__ALL__': 'UV'},
        'TEX_BRICK': {'__ALL__': 'UV'},
        'TEX_POINTDENSITY': {'__ALL__': 'OBJECT'},
        
        # Vector Nodes
        'NORMAL': {'Normal': 'OBJECT_NORMAL'},
        'NORMAL_MAP': {'Normal': 'TANGENT'},
        'BUMP': {'Normal': 'OBJECT_NORMAL'},
        'DISPLACEMENT': {'Displacement': 'OBJECT'},
        'VECTOR_TRANSFORM': {'Vector': 'OBJECT'},  # Default output space
        'VECTOR_CURVES': {'Vector': 'PRESERVE'},  # Inherits input space
        'VECTOR_ROTATE': {'Vector': 'PRESERVE'},  # Inherits input space
        'VECT_MATH': {'Vector': 'PRESERVE'},  # Inherits dominant input space
        
        # Geometry Nodes
        'NEW_GEOMETRY': {
            'Position': 'WORLD',
            'Normal': 'OBJECT_NORMAL',
            'Tangent': 'TANGENT',
            'True Normal': 'OBJECT_NORMAL',
            'Incoming': 'WORLD',
            'Parametric': 'UV',
            'Backfacing': 'SCREEN'
        },
        'GEOMETRY_TO_INSTANCE': {'__ALL__': 'INSTANCE'},
        'POSITION': {'Position': 'OBJECT'},  # Input position node
    },
    
    'input_spaces': {
        # Normal Mapping
        'NORMAL_MAP': {
            'Normal': 'TANGENT',  # Expects tangent-space normal
        },
        
        # Bump and Displacement
        'BUMP': {
            'Normal': 'OBJECT_NORMAL',
            'Height': 'OBJECT',
        },
        'DISPLACEMENT': {
            'Height': 'OBJECT',
            'Normal': 'OBJECT_NORMAL'
        },
        
        # Vector Transform
        'VECTOR_TRANSFORM': {
            'Vector': 'WORLD',  # Default input space
        },
        
        # Texture Nodes
        'MAPPING': {
            'Vector': 'PRESERVE',  # Inherits from connected node
        },
        
        # Shader Nodes
        'BSDF_PRINCIPLED': {
            'Normal': 'OBJECT_NORMAL',
            'Clearcoat Normal': 'OBJECT_NORMAL',
            'Tangent': 'TANGENT'
        },
        
        # Geometry Probes
        'RAYCAST': {
            'Ray Direction': 'WORLD',
            'Ray Origin': 'WORLD',
        },
        
        # UV Nodes
        'UVMAP': {'UV': 'UV'},
        'UV_UNWRAP': {'UV': 'UV'},
        
        # Special Cases
        'REFRACTION_BSDF': {
            'Normal': 'OBJECT_NORMAL',
        },
        'FRESNEL': {'Normal': 'OBJECT_NORMAL'},
        'LAYER_WEIGHT': {'Normal': 'OBJECT_NORMAL'},
    }
}

def calculate_vector_space(node, socket, type = 'output'):
    if node.type in vector_space_rules[type+'_spaces']:
        if socket.name in vector_space_rules[type+'_spaces'][node.type]:
            return vector_space_rules[type+'_spaces'][node.type][socket.name]
        elif '__ALL__' in vector_space_rules[type+'_spaces'][node.type]:
            return vector_space_rules[type+'_spaces'][node.type]['__ALL__']
        else:
            return 'PRESERVE'
            
    # TODO determine if appropriate
    elif socket.name == 'UV':
        return 'UV'
    else:
        return 'PRESERVE'

def serialize(target):
    modifier = None
    node_group = None
    name = ''
    if hasattr(target, 'modifiers'):
        modifier = next((m for m in target.modifiers if m.type == 'NODES' and m.node_group and '+logic' in m.node_group.name), None)
        if modifier is None:
            return (None, None)
        node_group = modifier.node_group
        name = node_group.name
    elif isinstance(target, bpy.types.Material):
        # if not '+compile' in target.name: return (None, None)
        modifier = target
        node_group = modifier.node_tree
        name = target.name
    elif isinstance(target, bpy.types.Scene):
        modifier = target
        node_group = modifier.compositing_node_group
        if not node_group: return (None, None)
        name = node_group.name or target.name
    elif isinstance(target, bpy.types.World):
        modifier = target
        node_group = modifier.node_tree
        if not node_group: return (None, None)
        name = target.name

    if not modifier or not node_group: return (None, None)

    def serialize_tree(node_tree, internal_trees = None):
        nodes_data = {}

        nodes_data['$treeType'] = 'composition' if isinstance(target, bpy.types.Scene) else 'environment' if isinstance(target, bpy.types.World) else 'material'

        if internal_trees == None:
            internal_trees = {}
            nodes_data['$internalTrees'] = internal_trees

        for node in node_tree.nodes:
            node_data = serialize_node(node, node_tree, internal_trees)
            nodes_data[node_data['id']] = node_data

        return nodes_data

    def serialize_node(node, node_tree, internal_trees):
        node_data = {
            "id": node.name,
            "type": 'REROUTE' if node.mute else node.type,
            "name": node.name,
            "inputs": {},
            "outputs": {},
            "properties": {}
        }

        for attribute in node.bl_rna.properties.keys():
            if attribute not in bpy.types.Node.bl_rna.properties.keys():
                if not hasattr(node, attribute): continue

                value = getattr(node, attribute)
                # print(attribute)
                # print(value)
                if isinstance(value, str) or isinstance(value, int) or isinstance(value, bool) or isinstance(value, float):
                    node_data["properties"][attribute] = value
                    # print(attribute)
        
        if node_tree.animation_data:
            drivers = [{"socket": node_tree.path_resolve('.'.join(driver.data_path.split('.')[:-1])).name, 'expression': driver.driver.expression} for driver in node_tree.animation_data.drivers if node_tree.path_resolve('.'.join(driver.data_path.split('.')[:-1])).node.name == node.name]

            if len(drivers):
                node_data['properties']['drivers'] = drivers

        if node.type == 'RGB':
            node_data['properties']['color'] = list(node.outputs[0].default_value)
        
        if node.type == 'VALTORGB':
            node_data['properties']['elements'] = []
            node_data['properties']['color_mode'] = node.color_ramp.color_mode
            node_data['properties']['interpolation'] = node.color_ramp.interpolation
            node_data['properties']['hue_interpolation'] = node.color_ramp.hue_interpolation

            for element in node.color_ramp.elements:
                node_data['properties']['elements'].append({
                    "position": element.position,
                    "color": list(element.color)
                })

        if node.type == 'TEX_IMAGE' and not node.image == None:
            image = node.image
            name = image.name
            filepath = image.filepath
            splitPath = re.split(r"[\\/]", filepath)
            filename = splitPath[-1]
            if '.' not in filename: filename = filename + '.png'
            if not filepath.startswith('//textures'):
                newpath = '//textures/' + filename
                print('[SAVE_IMAGE]', filepath, newpath)
                image.filepath = newpath
                try:
                    image.save()
                except:
                    print('unable to save', filepath)
                    # try:
                    #     image.unpack(method='WRITE_LOCAL')
                    # except:
                    #     pass

                    # try:
                    #     image.pack()
                    # except:
                    #     pass
            print('[IMAGE]', filepath, filename)
            node_data['properties']['image'] = filename
        
        # TODO handle vectors
        for input in node.inputs:
            if not input.enabled: continue
            value = None
            if hasattr(input, 'default_value'):
                    value = input.default_value

            if isinstance(value, (bpy.types.Object, bpy.types.Material)):
                value = f"{value.name}"
            elif input.type == 'VECTOR' or isinstance(value, (mathutils.Vector, mathutils.Euler)):
                print(node, value)
                if len(value) < 3:
                    value = [value[0], value[1]]
                else:
                    value = [value[0], value[1], value[2]]
            elif input.type == 'RGBA':
                value = list(value)
            elif isinstance(value, float):
                value = round(value, 6)
            elif is_struct(value):
                value = None

            name = input.name
            if input.is_linked:
                links = []

                def handleReroute(link):
                    if link.from_node.type == 'REROUTE':
                        for rerouteLink in link.from_node.inputs[0].links:
                            if not handleReroute(rerouteLink):
                                links.append({
                                    "node": rerouteLink.from_node.name,
                                    "socket": rerouteLink.from_socket.name
                                })

                        return True
                    
                    return False

                for link in input.links:
                    # if not handleReroute(link):
                    links.append({
                        "node": link.from_node.name,
                        "socket": 'Output' if link.from_node.mute else link.from_socket.name
                    })

                value = {"type": 'linked', "links": links, "intended_type": f"{input.type}", "default_value": value, }

                if node.mute and 'Input' not in node_data['inputs']:
                    name = 'Input'

                if value['intended_type'] == 'VECTOR':
                    value['incoming_vector_space'] = calculate_vector_space(input.links[0].from_node, input.links[0].from_socket)
                    value['intended_type'] = 'VECTOR' + str(len(input.default_value))
            else:
                value = {"value": value, "type": f"{input.type}", "input_hidden": input.hide_value}
                if input.type == 'VECTOR':
                    value['type'] = 'VECTOR' + str(len(input.default_value))
                
            if input.label:
                value['label'] = input.label

            if input.type == 'VECTOR':
                value['vector_space'] = calculate_vector_space(node, input, 'input')

                if not 'vector_space' in node_data['properties'] or node_data['properties']['vector_space'] == 'PRESERVE':
                    node_data['properties']['vector_space'] = value['vector_space']

            if input.name in node_data['inputs'] and not node.mute:
                existingValue = node_data['inputs'][input.name]

                if isinstance(existingValue, (list, tuple)):
                    existingValue.append(value)
                    value = existingValue
                else:
                    value = [existingValue, value]

            node_data['inputs'][name] = value
            
        for output in node.outputs:
            if output.is_unavailable: continue
            
            name = output.name
            value = None

            if hasattr(output, 'default_value'):
                value = output.default_value
        
            if isinstance(value, (bpy.types.Object, bpy.types.Material)):
                value = f"{value.name}"
            elif isinstance(value, (mathutils.Vector, mathutils.Euler)):
                value = list(value)
                # value = [value[0], value[1], value[2]]
            elif isinstance(value, float):
                value = round(value, 6)
            if is_struct(value):
                value = None

            if output.is_linked:
                links = []

                for link in output.links:
                    # if link.to_node.type == 'REROUTE':
                    #     # print(link.to_node.inputs[0].links[0])
                    #     for rerouteLink in link.to_node.outputs[0].links:
                    #         links.append({
                    #             "node": rerouteLink.to_node.name,
                    #             "socket": rerouteLink.to_socket.name
                    #         })
                    # else:
                    links.append({
                        "node": link.to_node.name,
                        "socket": 'Input' if link.to_node.mute else link.to_socket.name
                    })

                value = {"type": 'linked', "links": links, "intended_type": f"{output.type}", "default_value": value}
                if node.mute and 'Output' not in node_data['outputs']:
                    name = 'Output'

                if value['intended_type'] == 'VECTOR':
                    # value['incoming_vector_space'] = calculate_vector_space(input.links[0].from_node, input.links[0].from_socket)
                    value['intended_type'] = 'VECTOR' + str(len(output.default_value))
            else:
                value = {"value": value, "type": f"{output.type}"}
                if output.type == 'VECTOR':
                    value['type'] = 'VECTOR' + str(len(output.default_value))

            if node.type == 'VALUE':
                node_data['properties']['value'] = output.default_value

            if output.type == 'VECTOR':
                value['vector_space'] = calculate_vector_space(node, output)

                if not 'vector_space' in node_data['properties'] or node_data['properties']['vector_space'] == 'PRESERVE':
                    node_data['properties']['vector_space'] = value['vector_space']
                
            node_data['outputs'][name] = value

        if node.type == 'GROUP' and not node.node_tree == None and not node.mute:
            node_data['name'] = node.node_tree.name

            if len(node.node_tree.nodes) > 2:
                node_data['properties']['containsNodeTree'] = True

                if not node_data['name'] in internal_trees:
                    internal_trees[node_data['name']] = serialize_tree(node.node_tree, internal_trees)
                
                node_data["internalNodeTree"] = node_data['name']
                # for n in node.node_tree.nodes:
                #     serialize_node(n, node_data["name"] + "-")

                for internalN in internal_trees[node_data['name']]:
                    internalNode = internal_trees[node_data['name']][internalN]
                    # print("internalNode", node_data['name'], internal_trees[node_data['name']], internalN, internalNode)
                    if "type" in internalNode and internalNode['type'] == 'GROUP_INPUT':
                        for outputN in internalNode['outputs']:
                            if not outputN: continue

                            output = internalNode['outputs'][outputN]
                            groupInput = node_data['inputs'][outputN]
                            if 'vector_space' not in output or 'incoming_vector_space' not in groupInput: continue

                            # print("maybe determine vector space for group input", outputN, output, groupInput)
                            if not output['vector_space'] == 'PRESERVE' and not output['vector_space'] == groupInput['incoming_vector_space']:
                                print('[WARN] node group inputs have varying vector spaces', internalN, outputN, output['vector_space'], groupInput['incoming_vector_space'])
                            
                            output['vector_space'] = groupInput['incoming_vector_space']
        else:
            node_data['name'] = node.type

        return node_data
        
        
    serialized_tree = serialize_tree(node_group)

    output = json.dumps(serialized_tree, indent=2)
    fileName = name.replace('.', '-')
    if isinstance(target, bpy.types.Material):
        os.makedirs(bpy.path.abspath('//shaders'), exist_ok=True)
        fileName = 'shaders/' + fileName
        # target['shaderTree'] = output
    elif isinstance(target, bpy.types.World):
        os.makedirs(bpy.path.abspath('//shaders'), exist_ok=True)
        fileName = 'shaders/' + fileName
        # bpy.context.scene['worldShaderTree'] = output
    elif isinstance(target, bpy.types.Scene):
        os.makedirs(bpy.path.abspath('//shaders'), exist_ok=True)
        fileName = 'shaders/' + fileName
        # bpy.context.scene['compositionShaderTree'] = output
    else:
        os.makedirs(bpy.path.abspath('//logic-trees'), exist_ok=True)
        fileName = 'logic-trees/' + fileName
    #     bpy.context.scene[name] = output
    #     target['logicTree'] = name
    # print('set custom attrib?')

    
    hash = hashlib.md5(output.encode('utf-8')).hexdigest()
    output = output[:1] + '"hash": "' + hash + '",' + output[1:]

    with open(bpy.path.abspath('//'+fileName+'.json'), "w") as file:
        file.write(output)


    return (serialized_tree, name)


# import bpy
# import base64
# import zlib
# import struct

# def img_to_png(blender_image):
#     width = blender_image.size[0]
#     height = blender_image.size[1]
#     buf = bytearray([int(p * 255) for p in blender_image.pixels])

#     # reverse the vertical line order and add null bytes at the start
#     width_byte_4 = width * 4
#     raw_data = b''.join(b'\x00' + buf[span:span + width_byte_4]
#                         for span in range((height - 1) * width_byte_4, -1, - width_byte_4))

#     def png_pack(png_tag, data):
#         chunk_head = png_tag + data
#         return (struct.pack("!I", len(data)) +
#                 chunk_head +
#                 struct.pack("!I", 0xFFFFFFFF & zlib.crc32(chunk_head)))

#     png_bytes = b''.join([
#         b'\x89PNG\r\n\x1a\n',
#         png_pack(b'IHDR', struct.pack("!2I5B", width, height, 8, 6, 0, 0, 0)),
#         png_pack(b'IDAT', zlib.compress(raw_data, 9)),
#         png_pack(b'IEND', b'')])

#     return 'data:image/png;base64,' + base64.b64encode(png_bytes).decode()

# print(img_to_png(bpy.data.images['cloud4_mask_05.png']))

# Example usage
# obj = bpy.context.object
# export_geometry_nodes_to_json(obj)

#if json_data:
#    print(json_data)