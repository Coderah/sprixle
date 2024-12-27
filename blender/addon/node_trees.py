import bpy
import json
import mathutils

def is_struct(val):
    return val.__class__.__name__ == "bpy_prop_array" or isinstance(val, bpy.types.bpy_struct)

def serialize(target):
    modifier = None
    node_group = None
    name = ''
    if hasattr(target, 'modifiers'):
        modifier = next((m for m in target.modifiers if m.type == 'NODES' and '+logic' in m.node_group.name), None)
        if modifier is None:
            return
        node_group = modifier.node_group
        name = node_group.name
    elif isinstance(target, bpy.types.Material):
        if not '+compile' in target.name: return
        modifier = target
        node_group = modifier.node_tree
        name = target.name

    if not modifier or not node_group: return

    def serialize_tree(node_tree):
        nodes_data = {}

        for node in node_tree.nodes:
            node_data = serialize_node(node, node_tree)
            nodes_data[node_data['id']] = node_data

        return nodes_data

    def serialize_node(node, node_tree):
        node_data = {
            "id": node.name,
            "type": node.type,
            "name": node.name,
            "inputs": {},
            "outputs": {},
            "properties": {}
        }
        
        if node.type == 'GROUP' and not node.node_tree == None:
            node_data['name'] = node.node_tree.name

            if len(node.node_tree.nodes) > 2:
                node_data['properties']['containsLogicTree'] = True

                node_data["internalLogicTree"] = serialize_tree(node.node_tree)
                # for n in node.node_tree.nodes:
                #     serialize_node(n, node_data["name"] + "-")
        else:
            node_data['name'] = node.type

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
            node_data['properties']['image'] = node.image.name
        
        # TODO handle vectors
        for input in node.inputs:
            if not input.enabled: continue
            value = None
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
                        "socket": link.from_socket.name
                    })

                value = {"type": 'linked', "links": links, "intended_type": f"{input.type}"}
            else:
                if hasattr(input, 'default_value'):
                    value = input.default_value

                if isinstance(value, (bpy.types.Object, bpy.types.Material)):
                    value = f"{value.name}"
                elif input.type == 'VECTOR' or isinstance(value, (mathutils.Vector, mathutils.Euler)):
                    value = [value[0], value[2], value[1]]
                elif input.type == 'RGBA':
                    value = list(value)
                elif isinstance(value, float):
                    value = round(value, 6)
                elif is_struct(value):
                    value = None

                value = {"value": value, "type": f"{input.type}", "input_hidden": input.hide_value}
                
            if input.label:
                value['label'] = input.label
            if input.name in node_data['inputs']:
                existingValue = node_data['inputs'][input.name]

                if isinstance(existingValue, (list, tuple)):
                    existingValue.append(value)
                    value = existingValue
                else:
                    value = [existingValue, value]
            node_data['inputs'][input.name] = value
            
        for output in node.outputs:
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
                        "socket": link.to_socket.name
                    })

                value = {"type": 'linked', "links": links, "intended_type": f"{output.type}"}
            else:
                if hasattr(output, 'default_value'):
                    value = output.default_value
            
                if isinstance(value, (bpy.types.Object, bpy.types.Material)):
                    value = f"{value.name}"
                elif isinstance(value, (mathutils.Vector, mathutils.Euler)):
                    # value = list(value)
                    value = [value[0], value[2], value[1]]
                elif isinstance(value, float):
                    value = round(value, 6)
                if is_struct(value):
                    value = None
                
                value = {"value": value, "type": f"{output.type}"}

            if node.type == 'VALUE':
                node_data['properties']['value'] = output.default_value
                
            node_data['outputs'][output.name] = value

        return node_data
        
    serialized_tree = serialize_tree(node_group)

    output = json.dumps(serialized_tree, indent=0)
    if isinstance(target, bpy.types.Material):
        target['shaderTree'] = output
    else:
        bpy.context.scene[name] = output
    # print('set custom attrib?')

    return serialized_tree

# Example usage
# obj = bpy.context.object
# export_geometry_nodes_to_json(obj)

#if json_data:
#    print(json_data)