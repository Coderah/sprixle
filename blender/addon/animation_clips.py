import bpy
import json

def prepare_animation_properties():
    """
    Export all animations to custom properties using Blender 4.4 action slots system
    """
    scene = bpy.context.scene
    
    # Store all actions in scene custom properties
    export_actions_to_scene(scene)

    # TODO add action_name and action_slot to object, material, and node trees
    

def export_actions_to_scene(scene):
    """Export all actions with their slots and fcurves to scene custom properties"""
    actions_data = {}
    
    for action in bpy.data.actions:
        action_data = serialize_action_with_slots(action)
        if action_data:
            actions_data[action.name] = action_data

        for slot in action.slots:
            for user in slot.users():
                if not user.type == "SHADER":
                    user.id_data['animation'] = json.dumps({
                        "action_name": action.name,
                        "action_slot": user.id_data.animation_data.action_slot.name_display,
                    })

    for material in bpy.data.materials:
        if not hasattr(material, 'node_tree') or not material.node_tree or not hasattr(material.node_tree, 'animation_data'):
            continue

        animation_data = material.node_tree.animation_data
        if not animation_data or not animation_data.action: continue

        material['shader_animation'] = json.dumps({
                        "action_name": animation_data.action.name,
                        "action_slot": animation_data.action_slot.name_display,
                    })
    
    if actions_data:
        scene['anim_actions'] = json.dumps(actions_data, indent=0)

def serialize_action_with_slots(action):
    """Serialize an action with its slots, layers, strips, and fcurves"""
    action_data = {
        "name": action.name,
        "frame_range": [action.frame_range[0], action.frame_range[1]],
        "slots": {},
        "layers": []
    }
    
    # Serialize slots (Blender 4.4+)
    if hasattr(action, 'slots'):
        layer = action.layers[0]
        strip = layer.strips[0]

        for slot in action.slots:
            slot_data = {
                "name": slot.name_display,
                "is_selected": slot.select,
            }

            channelbag = strip.channelbag(slot)

            if channelbag:
                slot_data["strip"] = serialize_channelbag(channelbag)

            action_data["slots"][slot.name_display] = slot_data


    
    # Serialize layers and strips (Blender 4.4+)
    # if hasattr(action, 'layers'):
    #     layer = action.layers[0]
    #     layer_data = {
    #         "name": layer.name,
    #         "strips": []
    #     }
        
    #     strip = layer.strips[0]
    #     strip_data = {
    #     }
        
    #     # Serialize fcurves for this strip's channelbags
    #     if hasattr(strip, 'channelbags'):
    #         strip_data["channelbags"] = serialize_channelbags(strip)
        
    #     layer_data["strips"].append(strip_data)
        
    #     action_data["layers"].append(layer_data)
    
    # Also include direct fcurves for backward compatibility?
    # if action.fcurves:
    #     action_data["fcurves"] = serialize_fcurves(action.fcurves, action)
    
    return action_data

def serialize_channelbags(strip):
    """Serialize channelbags and their fcurves for a strip"""
    channelbags_data = {}
    
    # Get all slots that have channelbags in this strip
    for slot_idx in range(len(strip.channelbags)):
        channelbag = strip.channelbags[slot_idx]
        
            
        slot_name = channelbag.slot.name_display # f"slot_{slot_idx}"
        channelbags_data[slot_name] = serialize_channelbag(channelbag)
    
    return channelbags_data

def serialize_channelbag(channelbag):
    if not channelbag.fcurves:
        return {}

    return {
        "fcurves": serialize_fcurves(channelbag.fcurves, channelbag)
    }

def serialize_fcurves(fcurves, owner):
    """Serialize a collection of fcurves"""
    fcurves_data = []
    
    for fcurve in fcurves:
        fcurve_data = serialize_fcurve(fcurve, owner)
        if fcurve_data:
            fcurves_data.append(fcurve_data)
    
    return fcurves_data

def serialize_fcurve(fcurve, owner):
    """Serialize an FCurve with keyframes"""
    # Parse data path to determine what's being animated
    target_type, target_name, property_name = parse_animation_data_path(fcurve.data_path, owner)

    sampled_points = sample_keyframes(fcurve)

    fcurve_data = {
        "data_path": fcurve.data_path,
        "array_index": fcurve.array_index,
        "target_type": target_type,
        "target_name": target_name,
        "property_name": property_name,
        "keyframes": serialize_keyframes(fcurve.keyframe_points),
        "sampled_points": sampled_points,
        "interpolation": get_interpolation_type(fcurve.keyframe_points[0]) if fcurve.keyframe_points else "LINEAR"
    }
    
    # Add group information if available
    if fcurve.group:
        fcurve_data["group"] = fcurve.group.name
    
    return fcurve_data

def sample_keyframes(fcurve):
    sampled_points = []

    last_keyframe = None

    # Iterate through frames and evaluate the FCurve
    for keyframe in fcurve.keyframe_points:
        if not last_keyframe:
            last_keyframe = keyframe
            continue

        start_frame = int(last_keyframe.co[0])
        end_frame = int(keyframe.co[0])

        for frame in range(start_frame, end_frame + 1): 
            value = fcurve.evaluate(float(frame))
            sampled_points.append([frame, value])

        last_keyframe = keyframe

    return sampled_points

def serialize_keyframes(keyframe_points):
    """Serialize keyframe points"""
    keyframes = []
    
    for kf in keyframe_points:
        keyframe_data = {
            "frame": kf.co[0],
            "value": kf.co[1],
            "interpolation": get_interpolation_type(kf),
            "easing": get_easing_type(kf)
        }
        
        # Add handle data for Bezier interpolation
        if keyframe_data["interpolation"] == "BEZIER":
            keyframe_data.update({
                "handle_left": [kf.handle_left[0], kf.handle_left[1]],
                "handle_right": [kf.handle_right[0], kf.handle_right[1]],
                "handle_left_type": kf.handle_left_type,
                "handle_right_type": kf.handle_right_type
            })
        
        keyframes.append(keyframe_data)
    
    return keyframes

def get_interpolation_type(keyframe):
    """Get interpolation type for keyframe"""
    interpolation_map = {
        'BEZIER': 'BEZIER',
        'LINEAR': 'LINEAR', 
        'CONSTANT': 'STEP'
    }
    return interpolation_map.get(keyframe.interpolation, 'LINEAR')

def get_easing_type(keyframe):
    """Get easing type for keyframe (Blender 4.4+)"""
    if hasattr(keyframe, 'easing'):
        return keyframe.easing
    return 'AUTO'

def parse_animation_data_path(data_path, owner):
    """Parse animation data path to determine target type and name"""
    # Object transformations
    if data_path in ['location', 'rotation_euler', 'scale', 'rotation_quaternion']:
        return "transform", "object", data_path
    elif data_path.startswith('location') or data_path.startswith('rotation') or data_path.startswith('scale'):
        return "transform", "object", data_path.split('[')[0] if '[' in data_path else data_path
    else:
        return "driver", "path", data_path.split('[')[0] if '[' in data_path else data_path