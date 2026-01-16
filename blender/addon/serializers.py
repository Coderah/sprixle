import json
import bpy
import os

def view_layer(vlayer):
    data = serialize_bpy_object(vlayer, skip_attributes=['objects'])
    output = json.dumps(data, indent=2)

    os.makedirs(bpy.path.abspath('//view-layers'), exist_ok=True)
    with open(bpy.path.abspath('//view-layers/' + vlayer.name + '.json'), 'w') as file:
        file.write(output)




def serialize_bpy_object(bl_object, skip_attributes=None):
    """
    Serializes a bpy object's relevant properties into a dictionary.
    
    Args:
        bl_object (bpy.types.bpy_struct): The Blender object instance.
        skip_attributes (list): List of attribute names to ignore.

    Returns:
        dict: A dictionary containing the serializable properties.
    """
    if skip_attributes is None:
        skip_attributes = ['rna_type', 'name_full', 'path_from_id', 'users_group', '_RNA_UI']
    else:
        skip_attributes = skip_attributes + ['rna_type', 'name_full', 'path_from_id', 'users_group', '_RNA_UI']

    data = {}
    # Iterate over all properties defined by the RNA structure
    for prop in bl_object.bl_rna.properties:
        name = prop.identifier
        if name in skip_attributes:
            continue

        try:
            value = getattr(bl_object, name)
            # print(name, type(value))
            # Handle different bpy property types
            if isinstance(value, (int, float, str, bool)):
                data[name] = value
            elif isinstance(value, bpy.types.bpy_prop_collection):
                # print('attempt collection', name, value)
                data[name] = list(serialize_bpy_object(item) for item in list(value))
            elif isinstance(value, (list, tuple)):
                # Convert list/tuple of basic types (like colors or vectors)
                data[name] = list(value)
            elif isinstance(value, bpy.types.bpy_struct):
                # Recursively serialize nested bpy structures if necessary, 
                # or just store a reference (e.g., object name)
                # This example stores the name if available, otherwise skips
                data[name] = value.name if hasattr(value, 'name') else None
            # Note: Complex types like meshes, materials, or collections require
            # much more specific handling to capture all relevant data.

        except AttributeError:
            # Skip properties that are not readable
            continue
        except TypeError:
            # Skip properties that are not easily convertible
            continue

    return data