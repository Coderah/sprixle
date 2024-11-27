import bpy
import json
import mathutils

def is_struct(val):
    return val.__class__.__name__ == "bpy_prop_array" or isinstance(val, bpy.types.bpy_struct)

def export_geometry_nodes_to_json(obj):
    if not hasattr(obj, 'modifiers'): return
    modifier = next((m for m in obj.modifiers if m.type == 'NODES' and '+logic' in m.node_group.name), None)
    if modifier is None:
        return None

    node_tree = modifier.node_group
    nodes_data = {}

    for node in node_tree.nodes:
        node_data = {
            "id": node.name,
            "type": node.type,
            "name": node.name,
            "inputs": {},
            "outputs": {},
            "properties": {}
        }
        
        if node.type == 'GROUP':
            node_data['name'] = node.node_tree.name
        
        for input in node.inputs:
            value = None
            if input.is_linked:
                links = []

                for link in input.links:
                    if link.from_node.type == 'REROUTE':
                        # print(link.from_node.inputs[0].links[0])
                        for rerouteLink in link.from_node.inputs[0].links:
                            links.append({
                                "node": rerouteLink.from_node.name,
                                "socket": rerouteLink.from_socket.name
                            })
                    else:
                        links.append({
                            "node": link.from_node.name,
                            "socket": link.from_socket.name
                        })

                value = {"type": 'linked', "links": links}
            else:
                if hasattr(input, 'default_value'):
                    value = input.default_value
            
                if isinstance(value, (bpy.types.Object, bpy.types.Material)):
                    value = f"{value.name}"
                if is_struct(value):
                    value = None
                elif isinstance(value, (mathutils.Vector, mathutils.Euler)):
                    dval = list(value)
                elif isinstance(value, float):
                    dval = round(value, 6)
                
            node_data['inputs'][input.name] = value
            
        for output in node.outputs:
            value = None
            if output.is_linked:
                links = []

                for link in output.links:
                    if link.to_node.type == 'REROUTE':
                        # print(link.to_node.inputs[0].links[0])
                        for rerouteLink in link.to_node.outputs[0].links:
                            links.append({
                                "node": rerouteLink.to_node.name,
                                "socket": rerouteLink.to_socket.name
                            })
                    else:
                        links.append({
                            "node": link.to_node.name,
                            "socket": link.to_socket.name
                        })

                value = {"type": 'linked', "links": links}
            else:
                if hasattr(output, 'default_value'):
                    value = output.default_value
            
                if isinstance(value, (bpy.types.Object, bpy.types.Material)):
                    value = f"{value.name}"
                if is_struct(value):
                    value = None
                elif isinstance(value, (mathutils.Vector, mathutils.Euler)):
                    dval = list(value)
                elif isinstance(value, float):
                    dval = round(value, 6)
                
            node_data['outputs'][output.name] = value
            


        nodes_data[node_data['id']] = node_data
        
    

    output = json.dumps(nodes_data, indent=0)
    obj['logicTree'] = output
    print('set custom attrib?')

    return nodes_data

# Example usage
# obj = bpy.context.object
# export_geometry_nodes_to_json(obj)

#if json_data:
#    print(json_data)